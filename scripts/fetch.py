"""
Metals News & Learnings: daily data fetcher.

Runs on its own (GitHub Actions or your computer), no Claude or API keys needed.
Pulls free public data, scores it with simple transparent rules and writes
data/latest.json plus data/history.csv for the website to show.

Sources
- Prices:   Yahoo Finance chart API (gold, silver, copper futures, GDX, GLD, Brent)
- Macro:    FRED CSV downloads (Fed target, 10Y real yield, 10Y yield,
            10Y breakeven inflation, broad dollar index)
- Positioning: CFTC Commitments of Traders (disaggregated, futures only) via the
            CFTC public reporting API
- News:     Google News RSS searches + Mining.com feed, tagged by metal, topic
            and tone with keyword rules
- Central bank tonnes: data/central_banks.json (you update it monthly from the
            World Gold Council release; there is no free API for it)

Usage:  python scripts/fetch.py
"""
from __future__ import annotations

import csv
import datetime as dt
import email.utils
import html
import io
import json
import math
import re
import statistics
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CONFIG = json.loads((ROOT / "scripts" / "config.json").read_text(encoding="utf-8"))

UA = {"User-Agent": "Mozilla/5.0 (metals-news-learnings; +https://github.com/FizzaMubeen/metals)"}
TODAY = dt.datetime.now(dt.timezone.utc)
ERRORS: list[str] = []


def log(msg: str) -> None:
    print(msg, flush=True)


def get(url: str, *, params=None, timeout=30, tries=3) -> requests.Response | None:
    for i in range(tries):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=timeout)
            if r.status_code == 200:
                return r
            log(f"  {r.status_code} from {url}")
        except requests.RequestException as e:
            log(f"  error from {url}: {e}")
        time.sleep(2 * (i + 1))
    return None


def clamp(x: float, lo: float = -100, hi: float = 100) -> float:
    return max(lo, min(hi, x))


def pct(a: float, b: float) -> float | None:
    return None if not b else (a / b - 1) * 100


# ---------------------------------------------------------------- prices
def yahoo_series(symbol: str, rng: str = "2y") -> list[tuple[str, float]]:
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}"
    r = get(url, params={"range": rng, "interval": "1d"})
    if not r:
        ERRORS.append(f"Price download failed for {symbol}")
        return []
    try:
        res = r.json()["chart"]["result"][0]
        ts = res["timestamp"]
        closes = res["indicators"]["quote"][0]["close"]
    except (KeyError, IndexError, TypeError, ValueError):
        ERRORS.append(f"Unexpected price format for {symbol}")
        return []
    out = []
    for t, c in zip(ts, closes):
        if c is None:
            continue
        out.append((dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d"), float(c)))
    return out


def price_block(series: list[tuple[str, float]]) -> dict | None:
    if len(series) < 30:
        return None
    closes = [c for _, c in series]
    last = closes[-1]

    def back(n):
        return closes[-1 - n] if len(closes) > n else None

    ma50 = statistics.fmean(closes[-50:]) if len(closes) >= 50 else None
    ma200 = statistics.fmean(closes[-200:]) if len(closes) >= 200 else None
    return {
        "price": round(last, 4),
        "as_of": series[-1][0],
        "chg_1d": pct(last, back(1)),
        "chg_1m": pct(last, back(21)),
        "chg_1y": pct(last, back(252)),
        "high_2y": max(closes),
        "from_high_pct": pct(last, max(closes)),
        "ma50": ma50,
        "ma200": ma200,
        "history": [[d, round(c, 4)] for d, c in series[-260:]],
    }


# ---------------------------------------------------------------- FRED
def fred(series_id: str) -> list[tuple[str, float]]:
    r = get("https://fred.stlouisfed.org/graph/fredgraph.csv", params={"id": series_id})
    if not r:
        ERRORS.append(f"FRED download failed for {series_id}")
        return []
    rows = list(csv.reader(io.StringIO(r.text)))
    out = []
    for row in rows[1:]:
        if len(row) < 2:
            continue
        try:
            out.append((row[0], float(row[1])))
        except ValueError:
            continue  # "." = no value that day
    if not out:
        ERRORS.append(f"FRED returned no values for {series_id}")
    return out


def value_back(series: list[tuple[str, float]], days: int) -> float | None:
    """Value on or before (last date - days calendar days)."""
    if not series:
        return None
    last = dt.date.fromisoformat(series[-1][0])
    target = last - dt.timedelta(days=days)
    for d, v in reversed(series):
        if dt.date.fromisoformat(d) <= target:
            return v
    return None


# ---------------------------------------------------------------- CFTC COT
COT_URL = "https://publicreporting.cftc.gov/resource/72hh-3qpy.json"


def cot(code: str) -> list[dict]:
    r = get(COT_URL, params={
        "cftc_contract_market_code": code,
        "$order": "report_date_as_yyyy_mm_dd DESC",
        "$limit": 160,
    })
    if not r:
        ERRORS.append(f"CFTC download failed for {code}")
        return []
    out = []
    for row in r.json():
        try:
            lng = float(row["m_money_positions_long_all"])
            sht = float(row["m_money_positions_short_all"])
            oi = float(row["open_interest_all"])
            out.append({"date": row["report_date_as_yyyy_mm_dd"][:10], "net": lng - sht, "oi": oi})
        except (KeyError, ValueError, TypeError):
            continue
    out.sort(key=lambda x: x["date"])
    if not out:
        ERRORS.append(f"CFTC returned no rows for {code}")
    return out


# ---------------------------------------------------------------- news
def parse_rss(xml_text: str, feed_name: str) -> list[dict]:
    items = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        ERRORS.append(f"Could not read the {feed_name} feed")
        return items
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        pub = it.findtext("pubDate") or ""
        src_el = it.find("source")
        source = (src_el.text if src_el is not None and src_el.text else feed_name).strip()
        try:
            when = email.utils.parsedate_to_datetime(pub).astimezone(dt.timezone.utc)
        except (TypeError, ValueError):
            when = TODAY
        # Google News titles end with " - Publisher"
        if source and title.endswith(" - " + source):
            title = title[: -len(" - " + source)]
        items.append({"title": html.unescape(title), "url": link, "source": source,
                      "published": when.strftime("%Y-%m-%dT%H:%MZ")})
    return items


def fetch_news() -> list[dict]:
    items: list[dict] = []
    for q in CONFIG["news_queries"]:
        url = "https://news.google.com/rss/search"
        r = get(url, params={"q": q + " when:7d", "hl": "en-US", "gl": "US", "ceid": "US:en"})
        if r:
            items += parse_rss(r.text, "Google News")
    for feed in CONFIG["news_feeds"]:
        r = get(feed["url"])
        if r:
            items += parse_rss(r.text, feed["name"])
    # de-duplicate by normalised title
    seen, out = set(), []
    cutoff = TODAY - dt.timedelta(days=CONFIG["news_days"])
    for it in sorted(items, key=lambda x: x["published"], reverse=True):
        key = re.sub(r"[^a-z0-9]", "", it["title"].lower())[:90]
        if key in seen:
            continue
        if dt.datetime.strptime(it["published"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=dt.timezone.utc) < cutoff:
            continue
        seen.add(key)
        out.append(tag(it))
    return [n for n in out if n["metals"]][: CONFIG["news_max"]]


def has(text: str, words: list[str]) -> list[str]:
    return [w for w in words if re.search(r"\b" + re.escape(w), text)]


def tag(item: dict) -> dict:
    t = item["title"].lower()
    lex = CONFIG["lexicon"]
    item["metals"] = [m for m, words in lex["metals"].items() if has(t, words)]
    item["topics"] = [k for k, words in lex["topics"].items() if has(t, words)]
    up, down = len(has(t, lex["bullish"])), len(has(t, lex["bearish"]))
    item["tone"] = "bullish" if up > down else "bearish" if down > up else "neutral"
    # central bank buying / selling, with the country if named
    if "central banks" in item["topics"]:
        buy, sell = has(t, lex["cb_buy"]), has(t, lex["cb_sell"])
        item["cb_action"] = "buying" if buy and not sell else "selling" if sell and not buy else None
        item["cb_country"] = next((c for c, words in lex["countries"].items() if has(t, words)), None)
    return item


def news_score(news: list[dict], topic: str | None = None, metal: str | None = None, days: int = 7) -> tuple[float, int]:
    cutoff = (TODAY - dt.timedelta(days=days)).strftime("%Y-%m-%dT%H:%MZ")
    sel = [n for n in news if n["published"] >= cutoff
           and (topic is None or topic in n["topics"])
           and (metal is None or metal in n["metals"])]
    if topic == "central banks":
        up = sum(1 for n in sel if n.get("cb_action") == "buying")
        dn = sum(1 for n in sel if n.get("cb_action") == "selling")
    else:
        up = sum(1 for n in sel if n["tone"] == "bullish")
        dn = sum(1 for n in sel if n["tone"] == "bearish")
    n = up + dn
    if n == 0:
        return 0.0, len(sel)
    # net share, shrunk toward 0 when there are few headlines
    return clamp(100 * (up - dn) / n * min(1, n / 6)), len(sel)


# ---------------------------------------------------------------- scoring
def fmt(v, nd=2, suffix=""):
    return "n/a" if v is None else f"{v:,.{nd}f}{suffix}"


def build_factors(px: dict, macro: dict, cots: dict, news: list[dict], cb: dict) -> list[dict]:
    W = CONFIG["weights"]
    F = []

    def add(fid, group, name, score, reading, as_of, source, url, learn):
        if score is None:
            return
        w = W[fid]
        F.append({"id": fid, "group": group, "name": name, "score": round(clamp(score)), "reading": reading,
                  "as_of": as_of, "source": source, "url": url, "learning": learn,
                  "weight": w["w"], "applies": {k: w[k] for k in ("gold", "silver", "copper", "miners")}})

    # Fed: change in the target rate (upper bound) over the last 90 days
    s = macro.get("DFEDTARU")
    if s:
        now, before = s[-1][1], value_back(s, 90)
        chg = None if before is None else now - before
        score = None if chg is None else -200 * chg  # +0.25 pt (one hike) -> -50
        add("fed", "Macro", "Fed interest rate", score,
            f"Target rate upper bound {now:.2f}%, {fmt(chg, 2, ' pts')} in 3 months", s[-1][0],
            "FRED (DFEDTARU)", "https://fred.stlouisfed.org/series/DFEDTARU",
            "Rate hikes make cash and bonds pay more, which raises the cost of holding metals that pay no interest.")

    # Real yield: 1-month change, plus a penalty for a high level
    s = macro.get("DFII10")
    if s:
        now, before = s[-1][1], value_back(s, 30)
        chg_bp = None if before is None else (now - before) * 100
        score = None if chg_bp is None else -1.5 * chg_bp - 15 * (now - 1.5)
        add("real_yield", "Macro", "10Y real yield", score,
            f"{now:.2f}%, {fmt(chg_bp, 0, ' bp')} in a month", s[-1][0],
            "FRED (DFII10)", "https://fred.stlouisfed.org/series/DFII10",
            "The real (inflation-adjusted) yield is gold's main competitor. Falling real yields usually lift gold; rising ones weigh on it.")

    s = macro.get("DGS10")
    if s:
        now, before = s[-1][1], value_back(s, 30)
        chg_bp = None if before is None else (now - before) * 100
        add("nominal_10y", "Macro", "10Y Treasury yield", None if chg_bp is None else -1.0 * chg_bp,
            f"{now:.2f}%, {fmt(chg_bp, 0, ' bp')} in a month", s[-1][0],
            "FRED (DGS10)", "https://fred.stlouisfed.org/series/DGS10",
            "Bond yields move with rate expectations. A sharp rise pulls money toward bonds; a fall eases pressure on metals.")

    s = macro.get("DTWEXBGS")
    if s:
        now, before = s[-1][1], value_back(s, 30)
        chg = None if before is None else pct(now, before)
        add("dollar", "Macro", "US dollar (broad index)", None if chg is None else -25 * chg,
            f"{now:.1f}, {fmt(chg, 1, '%')} in a month", s[-1][0],
            "FRED (DTWEXBGS)", "https://fred.stlouisfed.org/series/DTWEXBGS",
            "Metals are priced in dollars. A weaker dollar makes them cheaper for the rest of the world, so prices tend to rise.")

    s = macro.get("T10YIE")
    if s:
        now, before = s[-1][1], value_back(s, 30)
        chg_bp = None if before is None else (now - before) * 100
        add("inflation", "Macro", "Inflation expectations", None if chg_bp is None else 2 * chg_bp,
            f"10Y breakeven {now:.2f}%, {fmt(chg_bp, 0, ' bp')} in a month", s[-1][0],
            "FRED (T10YIE)", "https://fred.stlouisfed.org/series/T10YIE",
            "When markets expect more inflation, gold is bought as a store of value.")

    b = px.get("brent")
    if b:
        add("oil", "Macro", "Oil (Brent)", clamp(1.5 * (b["chg_1m"] or 0)),
            f"${b['price']:.2f}, {fmt(b['chg_1m'], 1, '%')} in a month", b["as_of"],
            "Yahoo Finance (BZ=F)", "https://finance.yahoo.com/quote/BZ=F",
            "Oil spikes feed inflation fears (good for gold) but slow the economy and raise mining costs (bad for copper and miners).")

    # Central banks: monthly tonnes you enter + news tone
    cb_news, n_cb = news_score(news, topic="central banks", days=14)
    tonnes = cb.get("latest_month_net_tonnes")
    cb_score = cb_news if tonnes is None else 0.5 * cb_news + 0.5 * clamp(tonnes * 1.2)
    add("central_banks", "Flows", "Central bank buying", cb_score,
        (f"{cb.get('latest_month')}: net {tonnes:+.0f} t (World Gold Council). " if tonnes is not None else "")
        + f"{n_cb} central bank headlines in 14 days",
        cb.get("as_of") or TODAY.strftime("%Y-%m-%d"), "WGC (entered by hand) + news", "https://www.gold.org/goldhub/data/gold-reserves-by-country",
        "Central banks have been the biggest steady buyers of gold since 2022. Their buying sets a floor under prices over the long term.")

    etf_s, n_etf = news_score(news, topic="ETFs", days=14)
    if n_etf:
        add("etf", "Flows", "ETF flows (news)", etf_s, f"{n_etf} ETF headlines in 14 days",
            TODAY.strftime("%Y-%m-%d"), "News headlines", "https://www.gold.org/goldhub/data/gold-etfs-holdings-and-flows",
            "Gold ETFs show what Western investors are doing. Big inflows push prices up quickly; outflows do the opposite.")

    for metal, code_key, fid in (("gold", "gold", "cot_gold"), ("silver", "silver", "cot_silver"), ("copper", "copper", "cot_copper")):
        rows = cots.get(code_key) or []
        if len(rows) >= 20:
            shares = [r["net"] / r["oi"] * 100 for r in rows if r["oi"]]
            now = shares[-1]
            rank = sum(1 for x in shares if x <= now) / len(shares) * 100
            wk = rows[-1]["net"] - rows[-2]["net"]
            # contrarian: crowded longs are a risk, light positioning leaves room to buy
            add(fid, "Flows", f"Speculators in {metal}", (50 - rank) * 1.2,
                f"Net long {rows[-1]['net']:,.0f} contracts ({wk:+,.0f} on the week), "
                f"{rank:.0f}th percentile of 3 years", rows[-1]["date"],
                "CFTC Commitments of Traders", "https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm",
                "Hedge funds' bets (managed money). When they are already very long there are few buyers left, so pullbacks get likelier.")

    geo_s, n_geo = news_score(news, topic="geopolitics", metal="gold", days=7)
    if n_geo:
        add("geopolitics", "Sentiment", "Geopolitics (news)", max(0, geo_s) * 0.6 + 20 * min(1, n_geo / 10),
            f"{n_geo} gold headlines about conflict, sanctions or elections in 7 days",
            TODAY.strftime("%Y-%m-%d"), "News headlines", "https://news.google.com",
            "Wars, sanctions and political shocks send money into gold as a safe haven.")

    banks_s, n_banks = news_score(news, topic="bank research", days=21)
    if n_banks:
        add("bank_research", "Sentiment", "Bank forecasts (news)", banks_s,
            f"{n_banks} headlines on bank price targets in 3 weeks", TODAY.strftime("%Y-%m-%d"),
            "News headlines", "https://news.google.com",
            "JPMorgan, Goldman, Deutsche Bank and others publish best, base and worst cases. Watch the direction of their revisions more than the numbers.")

    for key, fid, name in (("gold", "trend_gold", "Gold price trend"), ("silver", "trend_silver", "Silver price trend"),
                           ("copper", "trend_copper", "Copper price trend")):
        p = px.get(key)
        if p and p["ma50"]:
            sc = (25 if p["price"] > p["ma50"] else -25) + ((25 if p["price"] > p["ma200"] else -25) if p["ma200"] else 0)
            sc += clamp(2 * (p["chg_1m"] or 0), -50, 50)
            add(fid, "Sentiment", name, sc,
                f"{fmt(p['chg_1m'], 1, '%')} in a month; {'above' if p['price'] > p['ma50'] else 'below'} 50-day average"
                + (f", {'above' if p['price'] > p['ma200'] else 'below'} 200-day" if p["ma200"] else ""),
                p["as_of"], "Yahoo Finance", "https://finance.yahoo.com",
                "Trend shows what buyers and sellers are actually doing. Long-term holders often add on dips within an uptrend.")

    g, m = px.get("gld"), px.get("miners")
    if g and m and g["chg_1m"] is not None and m["chg_1m"] is not None:
        rel = m["chg_1m"] - g["chg_1m"]
        add("miners", "Sentiment", "Miners vs gold", clamp(4 * rel),
            f"GDX {fmt(m['chg_1m'], 1, '%')} vs gold {fmt(g['chg_1m'], 1, '%')} in a month", m["as_of"],
            "Yahoo Finance (GDX, GLD)", "https://finance.yahoo.com/quote/GDX",
            "Mining shares often move before the metal. Miners beating gold is an early bullish sign; lagging is a warning.")

    gp, sp = px.get("gold"), px.get("silver")
    if gp and sp:
        ratio = gp["price"] / sp["price"]
        add("gs_ratio", "Sentiment", "Gold/silver ratio", clamp((ratio - 70) * 3),
            f"{ratio:.1f} ounces of silver per ounce of gold (long-run average about 65–70)", gp["as_of"],
            "Calculated from prices", "https://finance.yahoo.com",
            "A high ratio means silver is cheap next to gold, which has often favoured silver over the following year.")

    for metal in ("gold", "silver", "copper"):
        s_, n_ = news_score(news, metal=metal, days=7)
        if n_:
            add(f"news_{metal}", "Sentiment", f"{metal.title()} news tone", s_,
                f"{n_} {metal} headlines in 7 days", TODAY.strftime("%Y-%m-%d"), "News headlines", "https://news.google.com",
                "The overall tone of the news. Useful as a mood gauge, but extreme optimism often comes near tops.")
    return F


def asset_scores(factors: list[dict]) -> list[dict]:
    out = []
    for key, label in (("gold", "Gold"), ("silver", "Silver"), ("copper", "Copper"), ("miners", "Gold miners")):
        num = den = 0.0
        groups = {}
        for f in factors:
            k = f["applies"].get(key, 0)
            num += f["score"] * f["weight"] * k
            den += f["weight"] * abs(k)
            g = groups.setdefault(f["group"], [0.0, 0.0])
            g[0] += f["score"] * f["weight"] * k
            g[1] += f["weight"] * abs(k)
        score = round(num / den) if den else 0
        buy, sell = max(0, score), max(0, -score)
        verdict = ("Accumulate" if score >= 25 else "Lean buy" if score >= 10 else "Hold" if score > -10
                   else "Lean reduce" if score > -25 else "Reduce")
        out.append({"asset": key, "label": label, "score": score, "buy": buy, "hold": 100 - buy - sell, "sell": sell,
                    "verdict": verdict,
                    "groups": {g: (round(v[0] / v[1]) if v[1] else None) for g, v in groups.items()}})
    return out


def takeaways(factors: list[dict], assets: list[dict]) -> list[str]:
    gold = [f for f in factors if f["applies"].get("gold")]
    lines = []
    if gold:
        best = max(gold, key=lambda f: f["score"] * f["weight"])
        worst = min(gold, key=lambda f: f["score"] * f["weight"])
        if best["score"] > 0:
            lines.append(f"Biggest support for gold: {best['name']} ({best['reading']}).")
        if worst["score"] < 0:
            lines.append(f"Biggest headwind for gold: {worst['name']} ({worst['reading']}).")
    for a in assets:
        lines.append(f"{a['label']}: {a['verdict']} (score {a['score']:+d}).")
    return lines


def append_history(assets: list[dict], px: dict) -> None:
    path = DATA / "history.csv"
    today = TODAY.strftime("%Y-%m-%d")
    rows = []
    if path.exists():
        rows = [r for r in csv.DictReader(path.open(encoding="utf-8")) if r["date"] != today]
    row = {"date": today}
    for a in assets:
        row[f"{a['asset']}_score"] = a["score"]
    for k in ("gold", "silver", "copper", "miners"):
        row[f"{k}_price"] = px[k]["price"] if px.get(k) else ""
    rows.append(row)
    fields = ["date"] + [f"{k}_score" for k in ("gold", "silver", "copper", "miners")] + [f"{k}_price" for k in ("gold", "silver", "copper", "miners")]
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for r in rows[-730:]:
            w.writerow({k: r.get(k, "") for k in fields})


def main() -> int:
    DATA.mkdir(exist_ok=True)
    log("Prices…")
    px = {}
    for key, sym in CONFIG["symbols"].items():
        blk = price_block(yahoo_series(sym))
        if blk:
            blk["symbol"] = sym
            px[key] = blk
        log(f"  {key} ({sym}): {'ok' if blk else 'missing'}")

    log("Macro (FRED)…")
    macro = {sid: fred(sid) for sid in ("DFEDTARU", "DFII10", "DGS10", "DTWEXBGS", "T10YIE")}
    for k, v in macro.items():
        log(f"  {k}: {len(v)} values")

    log("Positioning (CFTC)…")
    cots = {k: cot(code) for k, code in CONFIG["cot_codes"].items()}
    for k, v in cots.items():
        log(f"  {k}: {len(v)} weeks")

    log("News…")
    news = fetch_news()
    log(f"  {len(news)} metal headlines")

    cb_path = DATA / "central_banks.json"
    cb = json.loads(cb_path.read_text(encoding="utf-8")) if cb_path.exists() else {}

    factors = build_factors(px, macro, cots, news, cb)
    assets = asset_scores(factors)
    if not px and not factors:
        log("Nothing could be fetched; keeping the previous data.")
        for e in ERRORS:
            log("  - " + e)
        return 1

    macro_out = {k: {"value": v[-1][1], "as_of": v[-1][0], "history": [[d, x] for d, x in v[-400:]]}
                 for k, v in macro.items() if v}
    latest = {
        "generated_at": TODAY.strftime("%Y-%m-%dT%H:%MZ"),
        "prices": px,
        "macro": macro_out,
        "cot": {k: v[-60:] for k, v in cots.items()},
        "factors": factors,
        "assets": assets,
        "takeaways": takeaways(factors, assets),
        "news": news,
        "central_banks": cb,
        "errors": ERRORS,
    }
    (DATA / "latest.json").write_text(json.dumps(latest, ensure_ascii=False, indent=1), encoding="utf-8")
    append_history(assets, px)
    log(f"Done: {len(factors)} indicators, {len(news)} headlines, {len(ERRORS)} problems.")
    for e in ERRORS:
        log("  - " + e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
