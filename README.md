# Metals Signal Tracker

A rules-based buy, hold or sell lean for **gold, silver, copper and gold miners (GDX)**, built from macro data, flows and sentiment. It runs entirely on GitHub: GitHub Pages hosts the site, and a GitHub Action fetches fresh data every morning. No servers, no API keys.

> A research aid, not financial advice.

## Set it up (about 5 minutes)

1. **Create a repository** on GitHub (for example `metals-signal-tracker`) and upload every file in this folder, keeping the folders (`assets/`, `data/`, `scripts/`, `.github/workflows/`).
2. **Turn on the website:** repository **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)`, then **Save**. After a minute the site is live at `https://<your-username>.github.io/<repo-name>/`.
3. **Let the daily update save data:** **Settings → Actions → General → Workflow permissions → Read and write permissions → Save**.
4. **Run the first update:** **Actions → Update data → Run workflow**. From then on it runs by itself every day at 05:54 UTC.

## How the data updates

| Kind | What | Where it comes from |
|---|---|---|
| **auto** | Prices, Fed rates, real and nominal yields, dollar, inflation and oil, speculator positioning (COT), miners, price trends | Yahoo Finance, FRED (St. Louis Fed), CFTC: all public, no key needed |
| **manual** | Central bank buying, ETF flows, Asia demand, copper supply, geopolitics, bank research | You edit `data/signals.json` (and `cb_flows.json`, `cb_summary.json`, `bank_targets.json`) |

- **auto** indicators are re-scored each morning by `scripts/update_data.py`. A score moves at most 15 points a day so leans change gradually.
- If a source is down, that indicator keeps its last value; the page never goes blank.
- The page header shows **Fetched &lt;time&gt;** with a green dot (fresh) or amber dot (older than 36 hours).
- **Refresh data** on the page reloads the newest saved data without reloading the page. To fetch new data immediately, use **Fetch new data on GitHub** (shown on the live site), click **Run workflow**, then press Refresh after a few minutes. GitHub Pages can take a few minutes to publish the new files.

## Editing a manual indicator

Open `data/signals.json` on GitHub, click the pencil, and change a row's `reading`, `as_of` (YYYY-MM-DD), `score` (−100 to +100), `source` and `url`. Leave `w` and the `f_*` columns alone unless you want to change how much an indicator counts. Commit, and the site updates.

Score guide: Fed hiking ≈ −50 to −70, cutting ≈ +50; central bank buying over 50 t a month ≈ +60 to +80; ETF inflows ≈ +30 to +50, outflows ≈ −20 to −40; geopolitical escalation ≈ +30 to +50; bank targets far above spot ≈ +30 to +40.

## How the lean is worked out

For each asset: `score = Σ(score × w × f) / Σ(w × |f|)`, rounded. 25 or more is **Accumulate**, 10 or more **Lean buy**, above −10 **Hold**, above −25 **Lean reduce**, otherwise **Reduce**.

## Files

```
index.html                     the page
assets/style.css               styling (light and dark mode)
assets/dash.js                 loads data/*.json and redraws the page
assets/app.js                  calculations and charts
data/*.json                    the data
scripts/update_data.py         the daily fetcher (Python standard library only)
.github/workflows/update-data.yml   runs the fetcher every morning
```

Run it locally: `python -m http.server` in this folder, then open http://localhost:8000.
