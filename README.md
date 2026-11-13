# Deadlock Competitive Meta — Weekly

Unofficial weekly pick, win & ban stats for Deadlock heroes, from pro and amateur matches recorded on [Deadfrag](https://www.deadfrag.com).

The site is a single static page (`index.html`) that reads `data/latest.json`. Every Saturday at 00:00 JST a GitHub Actions workflow collects the previous week's games, writes the data files and commits them; Cloudflare Pages redeploys on that commit.

## Data

```
data/
  latest.json          # the week shown on the site (incl. per-hero item lists with category & tier)
  weeks.json           # index of every saved week
  2026/
    11/
      week-1.csv       # one row per hero, every hero every week
```

- **Week:** Saturday 00:00 – Friday 24:00 JST. A game counts toward the week it started in.
- **File name:** filed under the month of the week's Saturday; `week-1` starts on that month's first Saturday.
- **Columns:** `hero, picks, pick_rate, win_rate, bans, ban_rate, items`
  - `pick_rate` = picks ÷ games (%), `win_rate` = wins ÷ picks (%), `ban_rate` = bans ÷ games with recorded bans (%). Rates are 0 when there is nothing to divide by.
  - `items` = every shop item bought at least once by a player on that hero that week (including items later sold), alphabetical, separated by `; `.
- Games without recorded player data are skipped. Games without recorded bans are left out of the ban numbers.
- Data added or corrected on Deadfrag after a week was saved is not picked up.

## Running it

Requires Node 20+. No dependencies.

```sh
node scripts/weekly.mjs                       # most recent finished week
WEEK_END=2026-11-14 node scripts/weekly.mjs   # the week ending on that Saturday (JST)
```

In GitHub: **Actions → Weekly stats → Run workflow** (optionally with a `week_end` date) runs the same job by hand.

If a run fails, nothing is committed and the site keeps showing the previous week.

## Hosting (Cloudflare Pages)

Connect this repository in Cloudflare Pages with **no build command** and **build output directory `/`**. Every push to `main` deploys.

## Disclaimer

Unofficial fan project, not affiliated with or endorsed by Valve or Deadfrag. Deadlock is a trademark of Valve Corporation. Hero and item names come from Deadfrag's data; no game art is used.
