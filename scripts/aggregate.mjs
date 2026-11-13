// Weekly aggregation of Deadlock competitive matches from Deadfrag.
//
// Week = Saturday 00:00 JST -> Friday 24:00 JST. By default the script
// aggregates the most recent week that has fully ended; pass weekEnd
// (YYYY-MM-DD, a Saturday, JST) to build a specific week.
// Pure logic: returns { week, csv, latest } and writes nothing.

import { decodeTurboStream } from "./turbo-stream.mjs";

const BASE = "https://www.deadfrag.com";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_DELAY_MS = 400;
const USER_AGENT =
  "deadlock-lab weekly stats (+https://github.com/pmansd/deadlock-lab)";

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fetchImpl = (url) => fetch(url, { headers: { "user-agent": USER_AGENT, accept: "*/*" } });

async function get(path, { attempts = 3 } = {}) {
  const url = path.startsWith("http") ? path : BASE + path;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await sleep(REQUEST_DELAY_MS);
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await sleep(2000 * (i + 1));
    }
  }
  throw lastErr;
}

async function getData(path) {
  return decodeTurboStream(await get(path));
}

function routeData(root, routeId) {
  const r = root[routeId];
  if (!r || !r.data) throw new Error(`Route ${routeId} missing in payload`);
  return r.data;
}

const toMs = (v) => (v == null ? null : new Date(v).getTime());

// JST calendar helpers (JST has no DST, a fixed +9h offset is exact).
function jstParts(ms) {
  const d = new Date(ms + JST_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() };
}
function jstMidnight(y, m, d) {
  return Date.UTC(y, m - 1, d) - JST_OFFSET_MS;
}
const pad = (n) => String(n).padStart(2, "0");
const ymd = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;

function resolveWeek(weekEnd) {
  let endMs;
  if (weekEnd) {
    const [y, m, d] = weekEnd.split("-").map(Number);
    endMs = jstMidnight(y, m, d);
    if (jstParts(endMs).dow !== 6) throw new Error("WEEK_END must be a Saturday (JST)");
  } else {
    // Most recent Saturday 00:00 JST at or before now.
    const p = jstParts(Date.now());
    const back = (p.dow - 6 + 7) % 7;
    endMs = jstMidnight(p.y, p.m, p.d) - back * DAY_MS;
  }
  const startMs = endMs - 7 * DAY_MS;
  const start = jstParts(startMs);
  const lastDay = jstParts(endMs - DAY_MS);
  // Files are filed under the month of the week's Saturday;
  // week-1 = the first Saturday of that month, week-2 the second, ...
  const weekOfMonth = Math.ceil(start.d / 7);
  return {
    startMs,
    endMs,
    label: `${ymd(start)} – ${ymd(lastDay)}`,
    startDate: ymd(start),
    endDate: ymd(lastDay),
    csvPath: `data/${start.y}/${pad(start.m)}/week-${weekOfMonth}.csv`,
  };
}

// Deadfrag bundles its hero and item catalogues as JSON in hashed JS chunks.
function unTemplate(body) {
  return body.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
    (_, c) => {
      if (c[0] === "u" && c.length > 1) return String.fromCodePoint(parseInt(c.replace(/[u{}]/g, ""), 16));
      if (c[0] === "x" && c.length === 3) return String.fromCharCode(parseInt(c.slice(1), 16));
      return { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" }[c] ?? c;
    },
  );
}

async function loadCatalogue(html, name) {
  const re = new RegExp(`/assets/${name}-([A-Za-z0-9_-]{8})\\.js`);
  const m = html.match(re);
  if (!m) throw new Error(`Could not find the ${name} catalogue chunk`);
  const js = await get(m[0]);
  const start = js.indexOf("JSON.parse(`");
  const end = js.indexOf("`)", start);
  if (start < 0 || end < 0) throw new Error(`Unexpected ${name} chunk format`);
  return JSON.parse(unTemplate(js.slice(start + 12, end)));
}

function isShopItem(item) {
  // Shop items have display names ("Toxic Bullets"); internal upgrade
  // entries are snake_case identifiers.
  return item.type === "upgrade" && !/^[a-z0-9_]+$/.test(item.name);
}

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

// ---------------------------------------------------------------- main

export async function aggregate({ weekEnd, fetch: customFetch, log = console.log } = {}) {
  if (customFetch) fetchImpl = customFetch;
  const week = resolveWeek(weekEnd);
  log(`Aggregating ${week.label} (JST) -> ${week.csvPath}`);

  // Hero catalogue (from the series listing page).
  const listHtml = await get("/series");
  const heroList = (await loadCatalogue(listHtml, "hero")).filter(
    (h) => h.player_selectable && !h.disabled && !h.prerelease_only,
  );
  const heroName = new Map(heroList.map((h) => [h.id, h.name]));

  // 1. Candidate series: walk the listing (newest first) until series start
  //    well before the week. Series that started up to 3 days before the
  //    window can still have games inside it.
  const earliest = week.startMs - 3 * DAY_MS;
  const candidates = [];
  for (let page = 1; page <= 100; page++) {
    const data = routeData(await getData(`/series.data?page=${page}`), "routes/series");
    const { items, totalPages } = data.seriesResult;
    let olderSeen = false;
    for (const s of items) {
      const st = toMs(s.startTime);
      if (st == null) continue;
      if (s.status === "completed" && st < earliest) olderSeen = true;
      if (st >= earliest && st < week.endMs && s.status !== "scheduled") candidates.push(s);
    }
    if (olderSeen || page >= totalPages) break;
  }
  log(`Candidate series: ${candidates.length}`);

  // 2. Games inside the window.
  let itemName = null;
  const games = [];
  for (const s of candidates) {
    const first = await getData(`/series/${s.id}/match/1.data`);
    const layout = routeData(first, "routes/series.$id.layout");
    for (const sm of layout.seriesMatches || []) {
      if (sm.status !== "completed") continue;
      const gs = toMs(sm.startTime) ?? toMs(sm.endTime) ?? toMs(s.startTime);
      if (gs == null || gs < week.startMs || gs >= week.endMs) continue;
      const root = sm.gameNumber === 1 ? first : await getData(`/series/${s.id}/match/${sm.gameNumber}.data`);
      const game = routeData(root, "routes/series.$id.match.$gameNumber");
      if (!itemName) {
        const html = await get(`/series/${s.id}/match/${sm.gameNumber}`);
        const items = await loadCatalogue(html, "item");
        itemName = new Map(items.filter(isShopItem).map((i) => [i.id, i.name]));
      }
      games.push({ series: s.id, gameNumber: sm.gameNumber, game });
    }
  }

  // 3. Aggregate.
  const stats = new Map();
  const statFor = (id) => {
    if (!heroName.has(id)) heroName.set(id, `Hero ${id}`);
    if (!stats.has(id)) stats.set(id, { picks: 0, wins: 0, bans: 0, items: new Set() });
    return stats.get(id);
  };
  heroList.forEach((h) => statFor(h.id));

  let pickedGames = 0;
  let bannedGames = 0;
  for (const { game } of games) {
    const players = game.players || [];
    if (game.hasData && players.length > 0 && game.match) {
      pickedGames++;
      const winner = game.match.winningTeam;
      const slotHero = new Map();
      for (const p of players) {
        const st = statFor(p.heroId);
        st.picks++;
        if (p.team === winner) st.wins++;
        slotHero.set(p.playerSlot, p.heroId);
      }
      for (const it of game.items || []) {
        const name = itemName.get(it.itemId);
        const hero = slotHero.get(it.playerSlot);
        if (name && hero != null) statFor(hero).items.add(name);
      }
    }
    const bans = game.bans || [];
    if (bans.length > 0) {
      bannedGames++;
      for (const b of bans) statFor(b.heroId).bans++;
    }
  }
  log(`Games in window: ${games.length} (with picks: ${pickedGames}, with bans: ${bannedGames})`);

  const rows = [...stats.entries()]
    .map(([id, s]) => ({
      hero: heroName.get(id),
      picks: s.picks,
      wins: s.wins,
      pick_rate: pct(s.picks, pickedGames),
      win_rate: pct(s.wins, s.picks),
      bans: s.bans,
      ban_rate: pct(s.bans, bannedGames),
      items: [...s.items].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.hero.localeCompare(b.hero));

  // 4. Write outputs.
  const header = ["hero", "picks", "pick_rate", "win_rate", "bans", "ban_rate", "items"];
  const csv =
    header.join(",") +
    "\n" +
    rows
      .map((r) => [r.hero, r.picks, r.pick_rate, r.win_rate, r.bans, r.ban_rate, r.items.join("; ")].map(csvCell).join(","))
      .join("\n") +
    "\n";

  const generatedAt = new Date().toISOString();
  const latest = {
    generatedAt,
    week: { start: week.startDate, end: week.endDate, timezone: "Asia/Tokyo" },
    games: pickedGames,
    csv: week.csvPath,
    heroes: rows.map(({ items, ...r }) => r),
  };

  return { week, csv, latest };
}
