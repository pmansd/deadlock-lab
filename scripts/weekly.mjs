#!/usr/bin/env node
// Weekly job: aggregate last week's Deadfrag matches and write the data files.
//
//   node scripts/weekly.mjs                       # most recent finished week
//   WEEK_END=2026-11-14 node scripts/weekly.mjs   # week ending that Saturday (JST)
//
// Files are written only after every request succeeded; on any error the
// script exits non-zero and nothing changes, so the site keeps last week's page.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate } from "./aggregate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const { week, csv, latest } = await aggregate({ weekEnd: process.env.WEEK_END });

  const csvFile = join(ROOT, week.csvPath);
  await mkdir(dirname(csvFile), { recursive: true });
  await writeFile(csvFile, csv);

  // Only move "latest" forward; rebuilding an older week leaves it alone.
  const latestFile = join(ROOT, "data/latest.json");
  let current = null;
  try { current = JSON.parse(await readFile(latestFile, "utf8")); } catch {}
  // A re-run that finds the same numbers keeps the original timestamp, so
  // backup runs don't move "last updated" or create a new commit.
  const same = (a, b) => JSON.stringify({ ...a, generatedAt: 0 }) === JSON.stringify({ ...b, generatedAt: 0 });
  if (current && same(current, latest)) latest.generatedAt = current.generatedAt;
  if (!current || current.week.start <= latest.week.start) {
    await writeFile(latestFile, JSON.stringify(latest, null, 2) + "\n");
  }

  const weeksFile = join(ROOT, "data/weeks.json");
  let weeks = [];
  try { weeks = JSON.parse(await readFile(weeksFile, "utf8")); } catch {}
  weeks = weeks.filter((w) => w.csv !== week.csvPath);
  weeks.push({ start: week.startDate, end: week.endDate, games: latest.games, csv: week.csvPath });
  weeks.sort((a, b) => b.start.localeCompare(a.start));
  await writeFile(weeksFile, JSON.stringify(weeks, null, 2) + "\n");

  console.log(`Wrote ${week.csvPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
