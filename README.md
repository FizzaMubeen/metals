# Metals News & Learnings

A small website that tracks gold, silver and copper every day: the news, who is
buying and who is selling (especially central banks), the key market data, and
what each factor teaches. It runs on its own: free public data, a Python script
and GitHub. No API keys, no paid services, no AI needed.

## What it shows

| Tab | What's on it |
|---|---|
| Overview | Price, day/month/year change and a buy / hold / sell bar for gold, silver, copper and gold miners, plus score history |
| Indicators | What is pushing each metal, from Fed rates, bond yields, the dollar, inflation, oil, central banks, ETFs, speculator positioning, geopolitics, bank forecasts, miners and price trend |
| News | Headlines from the last two weeks, tagged by metal, topic and tone (bullish / bearish / neutral) |
| Who's buying | Central bank tonnes by country, buying and selling headlines, and bank price targets compared with today's gold price |
| Learnings | Your own notes and a guide to what each factor means |

## How it works

1. `scripts/fetch.py` downloads the data:
   - **Prices:** Yahoo Finance (gold, silver, copper futures, GDX, GLD, Brent oil)
   - **Macro:** FRED, St. Louis Fed (Fed target rate, 10Y real yield, 10Y yield, inflation expectations, dollar index)
   - **Speculators:** CFTC Commitments of Traders (gold, silver, copper)
   - **News:** Google News RSS searches and Mining.com, tagged with keyword rules
2. It scores each indicator from −100 (bearish) to +100 (bullish) with simple
   rules, weights them per metal (`scripts/config.json`), and writes
   `data/latest.json` and `data/history.csv`.
3. A GitHub Actions workflow runs the script **every day at 05:30 UTC** and commits the new data.
4. GitHub Pages serves `index.html`, which reads the data files.

## Set up (once)

1. **Turn on the website:** repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)`. Your site will be at `https://fizzamubeen.github.io/metals/`.
2. **Let the workflow save data:** **Settings → Actions → General → Workflow permissions → Read and write permissions**.
3. **Run the first fetch:** **Actions → Daily fetch → Run workflow**.

## Fetch fresh data whenever you want

- **On GitHub:** Actions → Daily fetch → Run workflow (takes about a minute).
- **On your computer:**
  ```bash
  pip install -r requirements.txt
  python scripts/fetch.py
  python -m http.server 8000      # then open http://localhost:8000
  ```
  (Open the page through a local server; opening `index.html` directly from disk blocks the data files.)

## Things you update by hand

- **`data/central_banks.json`** (monthly): the World Gold Council publishes central bank buying early each month at gold.org/goldhub. There is no free API for this, so copy in the global net tonnes, the countries and any new bank price targets.
- **`data/learnings.json`** (any time): add your own notes; they appear on the Learnings tab.
- **`scripts/config.json`** (optional): change weights, news searches, keywords or countries.

## Changing the scoring

Each indicator has a weight `w` and a factor per metal (`gold`, `silver`,
`copper`, `miners`) in `scripts/config.json`. A negative factor flips the
effect (for example, oil spikes lift gold but hurt copper). The metal's score is
the weighted average; ≥25 reads *Accumulate*, ≥10 *Lean buy*, between −10 and
+10 *Hold*, ≤−10 *Lean reduce*, ≤−25 *Reduce*. The bar shows that score as
buy % (or sell %) with the rest as hold.

## Notes

- Yahoo Finance's chart endpoint is unofficial and can change; if prices stop
  loading, the page keeps the last good data and lists the problem at the top.
- News tone is keyword-based, so treat it as a mood gauge, not a fact.
- This is a research and learning tool, not financial advice.
