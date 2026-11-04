#!/usr/bin/env python3
"""Daily data refresh for the Metals Signal Tracker.

Fetches public market data (no API keys needed) and rewrites the JSON files in
data/. Indicators marked "mode": "auto" in data/signals.json are re-scored from
the new numbers; "manual" ones are left exactly as they are, for you to edit by
hand. If any source fails, that item keeps its previous value, so one bad
source never blanks the page.

Sources:
  Yahoo Finance chart API  - gold, silver, copper futures, GDX, dollar index, Brent, 10Y
  FRED (St. Louis Fed) CSV - 10Y TIPS real yield, 2Y yield, Fed funds target, CPI
  CFTC public reporting    - managed money positions (disaggregated COT)
"""
import csv
import io
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = {"User-Agent": "Mozilla/5.0 (metals-signal-tracker; +https://github.com)"}
NOW = datetime.now(timezone.utc).replace(microsecond=0)
MAX_STEP = 15  # a score moves at most this much per day, so readings change gradually

log_lines = []


def log(msg):
    log_lines.append(msg)
    print(msg, file=sys.stderr)


def get(url, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"{url}: {last}")


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def iso_day(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


# ---------------------------------------------------------------- sources
def yahoo(symbol):
    """Daily closes for the past year: list of (YYYY-MM-DD, close)."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?range=1y&interval=1d"
    j = json.loads(get(url))
    res = j["chart"]["result"][0]
    ts = res["timestamp"]
    closes = res["indicators"]["quote"][0]["close"]
    rows = [(iso_day(t), c) for t, c in zip(ts, closes) if c is not None]
    if len(rows) < 30:
        raise RuntimeError(f"{symbol}: too little history")
    return rows


def fred(series):
    """FRED series as list of (YYYY-MM-DD, value), missing values dropped."""
    text = get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}")
    out = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 2 or row[0].lower() in ("date", "observation_date"):
            continue
        try:
            out.append((row[0], float(row[1])))
        except ValueError:
            continue
    if not out:
        raise RuntimeError(f"FRED {series}: no data")
    return out


def cot(code):
    """Managed money net position history (newest first) for a CFTC contract code."""
    q = urllib.parse.urlencode({
        "$where": f"cftc_contract_market_code='{code}'",
        "$order": "report_date_as_yyyy_mm_dd DESC",
        "$limit": "160",
        "$select": "report_date_as_yyyy_mm_dd,m_money_positions_long_all,m_money_positions_short_all",
    })
    rows = json.loads(get("https://publicreporting.cftc.gov/resource/72hh-3qpy.json?" + q))
    out = []
    for r in rows:
        try:
            net = int(float(r["m_money_positions_long_all"])) - int(float(r["m_money_positions_short_all"]))
            out.append((r["report_date_as_yyyy_mm_dd"][:10], net))
        except (KeyError, ValueError):
            continue
    if len(out) < 10:
        raise RuntimeError(f"COT {code}: too little history")
    return out


# ---------------------------------------------------------------- helpers
def back(rows, days):
    """Value about `days` calendar days before the last row."""
    last = datetime.fromisoformat(rows[-1][0])
    target = last - timedelta(days=days)
    best = rows[0]
    for d, v in rows:
        if datetime.fromisoformat(d) <= target:
            best = (d, v)
        else:
            break
    return best[1]


def pct_change(rows, days=30):
    then = back(rows, days)
    return (rows[-1][1] / then - 1) * 100 if then else None


def sma(rows, n):
    vals = [v for _, v in rows[-n:]]
    return sum(vals) / len(vals) if vals else None


def step(old, target):
    """Move a score toward its target by at most MAX_STEP."""
    try:
        old = float(old)
    except (TypeError, ValueError):
        return round(target)
    return round(old + clamp(target - old, -MAX_STEP, MAX_STEP))


def fmt_money(v):
    return f"${v:,.0f}" if abs(v) >= 1000 else f"${v:,.2f}"


def load(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def save(name, rows):
    (DATA / name).write_text(json.dumps(rows, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


# ---------------------------------------------------------------- main
def main():
    prices = load("prices.json")
    signals = load("signals.json")
    by_asset = {p["asset"]: p for p in prices}
    by_id = {s["id"]: s for s in signals}
    series = {}

    def fetch(key, fn, *args):
        try:
            series[key] = fn(*args)
            log(f"ok   {key}")
        except Exception as e:  # noqa: BLE001
            log(f"FAIL {key}: {e}")

    for key, sym in [("gold", "GC=F"), ("silver", "SI=F"), ("copper", "HG=F"), ("gdx", "GDX"),
                     ("dxy", "DX-Y.NYB"), ("brent", "BZ=F"), ("tnx", "^TNX")]:
        fetch(key, yahoo, sym)
    for key, sid in [("tips", "DFII10"), ("dgs10", "DGS10"), ("dgs2", "DGS2"),
                     ("fed_u", "DFEDTARU"), ("fed_l", "DFEDTARL"), ("cpi", "CPIAUCSL")]:
        fetch(key, fred, sid)
    for key, code in [("cot_gold", "088691"), ("cot_silver", "084691"), ("cot_copper", "085692")]:
        fetch(key, cot, code)

    # ---- prices
    for asset, key in [("Gold", "gold"), ("Silver", "silver"), ("Copper", "copper"), ("Gold miners", "gdx")]:
        rows = series.get(key)
        p = by_asset.get(asset)
        if not rows or not p:
            continue
        last = rows[-1][1]
        p["price"] = round(last, 2) if last < 1000 else round(last)
        ch = pct_change(rows)
        p["change_1m_pct"] = round(ch, 1) if ch is not None else None
        hi = max(v for _, v in rows)
        if asset == "Gold miners":
            p["record"] = round(hi, 2)  # 52-week high
        else:
            p["record"] = round(max(float(p.get("record") or 0), hi), 2)
        p["as_of"] = rows[-1][0]
        p["source"] = "Yahoo Finance (futures)" if asset != "Gold miners" else "Yahoo Finance"
    for p in prices:
        p["fetched_at"] = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")

    # ---- auto signals
    def upd(sid, target, reading, as_of, source, url):
        s = by_id.get(sid)
        if not s or s.get("mode") != "auto":
            return
        s["score"] = step(s.get("score"), clamp(target, -100, 100))
        s["reading"] = reading
        s["as_of"] = as_of
        s["source"] = source
        s["url"] = url

    try:
        u, l, two = series["fed_u"], series["fed_l"], series["dgs2"]
        mid = (u[-1][1] + l[-1][1]) / 2
        spread = two[-1][1] - mid
        ch2 = two[-1][1] - back(two, 30)
        lean = "markets lean toward hikes" if spread > 0.15 else "markets lean toward cuts" if spread < -0.15 else "markets see rates on hold"
        upd("fed", clamp(-spread * 120 - ch2 * 40, -70, 50),
            f"Target range {l[-1][1]:.2f}–{u[-1][1]:.2f}%; 2-year yield {two[-1][1]:.2f}% ({spread:+.2f} pts vs the range midpoint), so {lean}",
            two[-1][0], "FRED (Fed target, 2Y Treasury)", "https://fred.stlouisfed.org/series/DGS2")
    except KeyError:
        pass

    try:
        t = series["tips"]
        lvl, ch = t[-1][1], t[-1][1] - back(t, 30)
        yr = t[-1][1] - back(t, 365)
        upd("real_yield", clamp(-(lvl - 1.0) * 25 - ch * 30, -70, 40),
            f"{lvl:.2f}% ({t[-1][0]}): {ch:+.2f} pts in a month, {yr:+.2f} pts on the year",
            t[-1][0], "FRED (DFII10)", "https://fred.stlouisfed.org/series/DFII10")
    except KeyError:
        pass

    try:
        n = series.get("dgs10") or [(d, v) for d, v in series["tnx"]]
        lvl, ch = n[-1][1], n[-1][1] - back(n, 30)
        upd("nominal_10y", clamp(-ch * 50, -40, 40),
            f"10-year Treasury yield {lvl:.2f}%, {ch:+.2f} pts over the past month",
            n[-1][0], "FRED (DGS10)", "https://fred.stlouisfed.org/series/DGS10")
    except KeyError:
        pass

    try:
        dx = series["dxy"]
        ch = pct_change(dx)
        upd("dxy", clamp(-ch * 12, -40, 40),
            f"Dollar index {dx[-1][1]:.1f}, {ch:+.1f}% over the past month",
            dx[-1][0], "Yahoo Finance (DX-Y.NYB)", "https://finance.yahoo.com/quote/DX-Y.NYB")
    except KeyError:
        pass

    try:
        cpi = series["cpi"]
        yoy = (cpi[-1][1] / cpi[-13][1] - 1) * 100
        br = series.get("brent")
        brent_txt, brent_ch = "", 0.0
        if br:
            brent_ch = pct_change(br)
            brent_txt = f"; Brent {fmt_money(br[-1][1])}, {brent_ch:+.1f}% in a month"
        month = datetime.fromisoformat(cpi[-1][0]).strftime("%b %Y")
        upd("inflation", clamp((yoy - 2) * 15 + brent_ch * 0.5, -30, 50),
            f"CPI inflation {yoy:.1f}% year on year ({month}){brent_txt}",
            br[-1][0] if br else cpi[-1][0], "FRED (CPI) / Yahoo Finance (Brent)", "https://fred.stlouisfed.org/series/CPIAUCSL")
    except (KeyError, IndexError):
        pass

    for sid, key, name in [("cot_gold", "cot_gold", "gold"), ("cot_silver", "cot_silver", "silver"), ("cot_copper", "cot_copper", "copper")]:
        rows = series.get(key)
        if not rows:
            continue
        net, prev = rows[0][1], rows[1][1]
        hist = sorted(v for _, v in rows)
        rank = sum(1 for v in hist if v <= net) / len(hist) * 100
        crowd = "crowded long" if rank >= 80 else "light positioning, room to rebuild" if rank <= 20 else "mid-range"
        side = "long" if net >= 0 else "short"
        upd(sid, clamp(25 - rank * 0.5, -25, 25),
            f"Net {side} {abs(net):,} contracts ({rows[0][0]}), {net - prev:+,} on the week; {rank:.0f}th percentile of 3 years, {crowd}",
            rows[0][0], "CFTC (disaggregated COT)", "https://publicreporting.cftc.gov/stories/s/r4w3-av2u")

    try:
        g = series["gdx"]
        ch = pct_change(g)
        hi = max(v for _, v in g)
        upd("miners", clamp(ch * 2.5, -40, 40),
            f"GDX {fmt_money(g[-1][1])}, {ch:+.1f}% in a month and {(g[-1][1] / hi - 1) * 100:+.0f}% from its 52-week high",
            g[-1][0], "Yahoo Finance (GDX)", "https://finance.yahoo.com/quote/GDX")
    except KeyError:
        pass

    for sid, key, asset, unit in [("momentum", "gold", "Gold", "/oz"), ("copper_trend", "copper", "Copper", "/lb")]:
        rows = series.get(key)
        if not rows:
            continue
        ch = pct_change(rows)
        ma = sma(rows, 200)
        vs_ma = (rows[-1][1] / ma - 1) * 100 if ma else 0
        rec = float(by_asset[asset].get("record") or 0)
        rec_txt = f", {(rows[-1][1] / rec - 1) * 100:+.0f}% from the record" if rec else ""
        upd(sid, clamp(ch * 5 + vs_ma * 0.5, -40, 40),
            f"{fmt_money(rows[-1][1])}{unit}, {ch:+.1f}% in a month, {vs_ma:+.1f}% vs its 200-day average{rec_txt}",
            rows[-1][0], "Yahoo Finance (futures)", "https://finance.yahoo.com/quote/" + ("GC=F" if key == "gold" else "HG=F"))

    save("prices.json", prices)
    save("signals.json", signals)

    # summary for the Actions log
    assets = {"Gold": "f_gold", "Silver": "f_silver", "Copper": "f_copper", "Gold miners": "f_miners"}
    for a, f in assets.items():
        num = sum(float(s["score"]) * float(s["w"]) * float(s[f]) for s in signals)
        den = sum(float(s["w"]) * abs(float(s[f])) for s in signals)
        sc = round(num / den) if den else 0
        v = "Accumulate" if sc >= 25 else "Lean buy" if sc >= 10 else "Hold" if sc > -10 else "Lean reduce" if sc > -25 else "Reduce"
        log(f"{a}: {sc:+d} {v}")
    failed = [l for l in log_lines if l.startswith("FAIL")]
    if len(failed) == len([k for k in log_lines if k.startswith(("ok", "FAIL"))]):
        log("Every source failed; nothing new was fetched.")
        sys.exit(1)


if __name__ == "__main__":
    main()
