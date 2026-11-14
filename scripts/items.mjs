#!/usr/bin/env node
// Weekly item usage in high-rank ranked matches (top ~10% by average badge),
// from the public Deadlock API (https://api.deadlock-api.com).
//
//   node scripts/items.mjs                       # most recent finished week
//   WEEK_END=2026-11-14 node scripts/items.mjs   # week ending that Saturday (JST)
//
// Usage rate = players who bought the item at least once ÷ all players in
// those matches (each match has 12 players). Writes, only on full success:
//   data/items/YYYY/MM/week-N.csv   every shop item, every week
//   data/items/latest.json          what items/index.html renders
//   items/icons/<id>.webp           item icons (downloaded once)

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWeek } from "./aggregate.mjs";

const API = "https://api.deadlock-api.com";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOP_SHARE = 0.10; // top 10% of ranked matches by average badge
const UA = { "user-agent": "deadlock-lab weekly item stats (+https://github.com/pmansd/deadlock-lab)" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchRetry(url, as = "json") {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return as === "json" ? await res.json() : Buffer.from(await res.arrayBuffer());
    } catch (err) {
      last = err;
      await sleep(3000 * (i + 1));
    }
  }
  throw last;
}
const qs = (o) => Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
const isShopItem = (i) => i.type === "upgrade" && !/^[a-z0-9_]+$/.test(i.name);
const csvCell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const exists = (p) => access(p).then(() => true, () => false);

async function main() {
  const week = resolveWeek(process.env.WEEK_END);
  const from = Math.floor(week.startMs / 1000);
  const to = Math.floor(week.endMs / 1000) - 1;
  const csvPath = week.csvPath.replace(/^data\//, "data/items/");
  console.log(`Item usage ${week.label} (JST) -> ${csvPath}`);
  const window = { match_mode: "ranked", min_unix_timestamp: from, max_unix_timestamp: to };

  // 1. Badge cutoff: the highest badges that together cover >= 10% of matches.
  const dist = await fetchRetry(`${API}/v1/analytics/badge-distribution?${qs(window)}`);
  const total = dist.reduce((s, b) => s + b.total_matches, 0);
  if (!total) throw new Error("No ranked matches in this week");
  let acc = 0, minBadge = 0;
  for (const b of [...dist].sort((a, b) => b.badge_level - a.badge_level)) {
    acc += b.total_matches;
    minBadge = b.badge_level;
    if (acc / total >= TOP_SHARE) break;
  }
  const share = acc / total;
  console.log(`Badge cutoff ${minBadge}: ${acc} of ${total} ranked matches (${(share * 100).toFixed(1)}%)`);

  const filter = { ...window, min_average_badge: minBadge };

  // 2. Denominator: every player in those matches (hero stats count one per player).
  const heroStats = await fetchRetry(`${API}/v1/analytics/hero-stats?${qs(filter)}`);
  const players = heroStats.reduce((s, h) => s + (h.matches || 0), 0);
  if (!players) throw new Error("No player data for the high-rank matches");

  // 3. Purchases per item.
  const itemStats = await fetchRetry(`${API}/v1/analytics/item-stats?${qs({ ...filter, min_matches: 1 })}`);
  const bought = new Map(itemStats.map((s) => [s.item_id, s.matches]));

  // 4. Item catalogue (English + the game's Japanese names) and rank names.
  const [itemsEn, itemsJa, ranksEn, ranksJa] = await Promise.all([
    fetchRetry(`${API}/v1/assets/items/by-type/upgrade?language=english`),
    fetchRetry(`${API}/v1/assets/items/by-type/upgrade?language=japanese`).catch(() => []),
    fetchRetry(`${API}/v1/assets/ranks?language=english`),
    fetchRetry(`${API}/v1/assets/ranks?language=japanese`).catch(() => []),
  ]);
  const jaName = new Map(itemsJa.map((i) => [i.id, i.name]));
  // Only items currently sold in the shop (drops removed/disabled/test entries).
  const shop = itemsEn.filter((i) => isShopItem(i) && i.shopable !== false);

  const tier = Math.floor(minBadge / 10), sub = minBadge % 10;
  const rankName = (list) => (list.find((r) => r.tier === tier) || {}).name;
  const badge = {
    min: minBadge,
    en: `${rankName(ranksEn) || `Tier ${tier}`} ${sub}`,
    ja: `${rankName(ranksJa) || rankName(ranksEn) || `Tier ${tier}`} ${sub}`,
    share: Math.round(share * 1000) / 10,
  };

  const rows = shop
    .map((i) => {
      const n = bought.get(i.id) || 0;
      const ja = jaName.get(i.id);
      return {
        id: i.id,
        name: i.name,
        name_ja: ja && !/^[a-z0-9_]+$/.test(ja) ? ja : i.name,
        slot: i.item_slot_type || "other",
        tier: i.item_tier || 0,
        purchases: n,
        usage_rate: Math.round((n / players) * 10000) / 100,
        icon: i.shop_image_webp || i.image_webp || null,
      };
    })
    .sort((a, b) => a.slot.localeCompare(b.slot) || b.usage_rate - a.usage_rate || a.name.localeCompare(b.name));

  // 5. Icons (kept in the repo so the page never loads them from elsewhere).
  const iconDir = join(ROOT, "items/icons");
  await mkdir(iconDir, { recursive: true });
  let fetched = 0;
  for (const r of rows) {
    const file = join(iconDir, `${r.id}.webp`);
    if (!r.icon || (await exists(file))) continue;
    try {
      await writeFile(file, await fetchRetry(r.icon, "buffer"));
      fetched++;
    } catch (err) {
      console.log(`Icon missing for ${r.name}: ${err.message}`);
    }
  }
  for (const r of rows) r.has_icon = await exists(join(iconDir, `${r.id}.webp`));
  console.log(`Icons downloaded: ${fetched}`);

  // 6. Write files.
  const header = ["item_id", "item", "item_ja", "slot", "tier", "purchases", "usage_rate"];
  const csv = header.join(",") + "\n" +
    rows.map((r) => [r.id, r.name, r.name_ja, r.slot, r.tier, r.purchases, r.usage_rate].map(csvCell).join(",")).join("\n") + "\n";
  const csvFile = join(ROOT, csvPath);
  await mkdir(dirname(csvFile), { recursive: true });
  await writeFile(csvFile, csv);

  const latestFile = join(ROOT, "data/items/latest.json");
  let current = null;
  try { current = JSON.parse(await readFile(latestFile, "utf8")); } catch {}

  // Previous week's rates, for the week-over-week change shown on the page.
  let previous = null;
  if (current && current.week.start < week.startDate) {
    previous = { week: current.week, rates: Object.fromEntries(current.items.map((i) => [i.id, i.usage_rate])) };
  } else if (current && current.week.start === week.startDate) {
    previous = current.previous || null;
  }

  const latest = {
    generatedAt: new Date().toISOString(),
    week: { start: week.startDate, end: week.endDate, timezone: "Asia/Tokyo" },
    badge,
    matches: Math.round(players / 12),
    players,
    csv: csvPath,
    items: rows.map(({ icon, ...r }) => r),
    previous,
  };
  const same = (a, b) => JSON.stringify({ ...a, generatedAt: 0 }) === JSON.stringify({ ...b, generatedAt: 0 });
  if (current && same(current, latest)) latest.generatedAt = current.generatedAt;
  if (!current || current.week.start <= latest.week.start) {
    await writeFile(latestFile, JSON.stringify(latest, null, 2) + "\n");
  }
  console.log(`Wrote ${csvPath} (${rows.length} items, ~${latest.matches} matches)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
