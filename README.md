# pvc-market-tracker

**Resin Watch** is a one-page dashboard that keeps tabs on the free, official indicators
that move PVC resin prices: the resin and plastics-pipe Producer Price Indexes, WTI crude
and Henry Hub natural gas. A scheduled GitHub Action pulls fresh numbers from FRED every
weekday morning and republishes the page on GitHub Pages. No server, no keys, nothing to
babysit.

Live page (after the one-time setup below): **https://rebridge.github.io/pvc-market-tracker/**

## How it works

```
series.json  ──►  scripts/fetch-data.mjs  ──►  docs/data/*.json  ──►  docs/index.html (GitHub Pages)
 (what to track)    (runs in GitHub Actions)    (committed to repo)     (reads the JSON, draws charts)
```

- `series.json` lists the FRED series to track. Add a line, and the next run picks it up.
- `scripts/fetch-data.mjs` downloads each series as CSV from FRED and writes one JSON file per
  series plus a `manifest.json`. If a pull fails, the previous data is kept and the failure is
  shown on the page.
- `.github/workflows/update-data.yml` runs weekdays at 13:30 UTC (9:30 am Eastern), commits
  any new observations, and deploys the `docs/` folder to GitHub Pages.
- `docs/` is the site. Plain HTML, CSS and JavaScript, no build step and no dependencies.

## One-time setup (about two minutes)

1. Merge this branch into `main`. Scheduled workflows only run from the default branch.
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
   (The workflow also tries to enable this itself; if it already worked, the setting is filled in.)
3. Open **Actions → Update data and publish → Run workflow** to do the first pull without
   waiting for the schedule.
4. Share the link: `https://rebridge.github.io/pvc-market-tracker/`

## Knobs on the page

| Knob | What it does |
|---|---|
| Time window | 1, 3, 5, 10 years or everything FRED has. |
| Lines on the chart | Turn each indicator on or off. |
| How to compare | *Same start = 100* puts every line on one percent scale. *Actual prices* shows each in its own units. |
| Shift oil & gas forward | Slides the feedstock lines 0 to 6 months later, to see how long resin takes to catch up. |
| Show table | The same numbers as a monthly table. |

Choices are remembered in the browser, so Bobby's view stays the way he left it.

## Adding or changing an indicator

Find the series on [FRED](https://fred.stlouisfed.org), copy its id from the page URL, and add an
entry to `series.json`:

```json
{
  "id": "DCOILBRENTEU",
  "key": "brent",
  "label": "Crude oil, Brent spot",
  "short": "Brent oil",
  "role": "The overseas oil benchmark",
  "units": "$ per barrel",
  "freq": "daily",
  "source": "U.S. Energy Information Administration, via FRED",
  "url": "https://fred.stlouisfed.org/series/DCOILBRENTEU",
  "note": "One or two sentences Bobby will read under About each line."
}
```

`freq` must be `daily` or `monthly`; daily series are averaged to months on the comparison chart
and get the lag slider. Keep the list to six or fewer so the chart stays readable.

A PVC-only PPI would be the ideal first line. BLS publishes PVC resin as an item under
industry 325211, but it is not carried on FRED under a stable id, so this tracker uses the
thermoplastic-resins basket (WPU0662) that contains it.

## Running locally

```
node scripts/fetch-data.mjs      # writes docs/data/
npx serve docs                   # or any static file server
```

## Why these four series

- **WPU0662, thermoplastic resins PPI.** The official monthly echo of resin contract settlements.
  Closest free stand-in for the Plastics News PVC chart, which is now subscriber-only.
- **PCU326122326122, plastics pipe and fittings PPI.** What pipe sells for. Resin versus pipe is
  a rough read on converter margins.
- **DCOILWTICO, WTI crude.** The headline. It affects U.S. PVC mainly through export pricing,
  because overseas ethylene is made from oil-derived naphtha.
- **DHHNGSP, Henry Hub gas.** The domestic feedstock signal. U.S. ethylene comes from ethane, a
  natural gas liquid, and chlorine production is electricity-heavy.
