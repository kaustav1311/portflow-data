"""
A2 helpers: Binance public klines, indicator computation, zone-crossing detector
with N-of-M fakeout filter, history merge logic.

History persistence model: data/ta_history.json holds last 250 bars per
(symbol, timeframe) plus computed indicators per bar. Each run pulls only the
latest bars from Binance, merges, recomputes indicators on the tail.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any

import pandas as pd
import pandas_ta as ta
import requests

BINANCE_KLINES_URL = "https://data-api.binance.com/api/v3/klines"
HISTORY_PATH = "data/ta_history.json"
SNAPSHOTS_PATH = "data/ta_snapshots.json"

TIMEFRAMES = ["1h", "4h", "1d", "1w"]
HISTORY_RETAIN_BARS = 250
BACKFILL_BARS = 300        # used when a symbol has no history yet
INCREMENTAL_BARS = 10      # used on every subsequent run

# Recency windows per timeframe (in bars of that timeframe)
RECENCY_WINDOW_BARS = {"1h": 10, "4h": 9, "1d": 7, "1w": 4}

# N-of-M crossing filter constants
CROSS_LOOKBACK = 5         # bars N-4 to N
CROSS_CONFIRM_BARS = 2     # last 2 bars confirm
CROSS_PRE_BARS_REQUIRED = 2  # at least 2 of bars N-4 to N-2 must satisfy "before" state

RSI_LOWER = 40.0
RSI_UPPER = 60.0


# ──────────────────────────────────────────────────────────────────────────────
# Klines fetch
# ──────────────────────────────────────────────────────────────────────────────

def fetch_klines(symbol: str, interval: str, limit: int) -> list[dict]:
    """
    Fetch klines from Binance public endpoint. Returns list of bar dicts:
    {t (ms close), o, h, l, c, v}. Hard-fails on non-200 or empty response.
    """
    pair = f"{symbol.upper()}USDT"
    params = {"symbol": pair, "interval": interval, "limit": limit}
    r = requests.get(BINANCE_KLINES_URL, params=params, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(
            f"Binance klines failed for {pair} {interval}: "
            f"HTTP {r.status_code} — {r.text[:200]}"
        )
    raw = r.json()
    if not isinstance(raw, list) or len(raw) == 0:
        raise RuntimeError(f"Binance klines returned empty for {pair} {interval}")
    bars: list[dict] = []
    for k in raw:
        # Binance kline schema: [openTime, o, h, l, c, v, closeTime, ...]
        bars.append({
            "t": int(k[6]),       # close timestamp, ms UTC
            "o": float(k[1]),
            "h": float(k[2]),
            "l": float(k[3]),
            "c": float(k[4]),
            "v": float(k[5]),
        })
    return bars


# ──────────────────────────────────────────────────────────────────────────────
# History I/O
# ──────────────────────────────────────────────────────────────────────────────

def load_history() -> dict:
    """Load ta_history.json. Returns empty dict if file missing or empty."""
    if not os.path.exists(HISTORY_PATH):
        return {}
    # NEW: handle empty file case
    if os.path.getsize(HISTORY_PATH) == 0:
        return {}
    try:
        with open(HISTORY_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise RuntimeError("ta_history.json root must be a dict")
        return data
    except json.JSONDecodeError as e:
        raise RuntimeError(f"ta_history.json is corrupt: {e}")


def merge_bars(existing: list[dict], fresh: list[dict]) -> list[dict]:
    """
    Merge fresh bars into existing, deduped by timestamp, latest-wins.
    Returns sorted ascending, trimmed to HISTORY_RETAIN_BARS.
    """
    by_t: dict[int, dict] = {b["t"]: b for b in existing}
    for b in fresh:
        by_t[b["t"]] = b  # fresh wins on collision
    merged = sorted(by_t.values(), key=lambda x: x["t"])
    return merged[-HISTORY_RETAIN_BARS:]


# ──────────────────────────────────────────────────────────────────────────────
# Indicators
# ──────────────────────────────────────────────────────────────────────────────

def compute_indicators(bars: list[dict]) -> list[dict]:
    """
    Given a list of OHLCV bars, return the same list with indicator fields
    appended per bar. NaN → None in JSON output (handled at write time).
    """
    if len(bars) < 2:
        return bars

    df = pd.DataFrame(bars)
    close = df["c"]
    high = df["h"]
    low = df["l"]
    vol = df["v"]

    df["rsi"] = ta.rsi(close, length=14)
    df["ema20"] = ta.ema(close, length=20)
    df["ema50"] = ta.ema(close, length=50)
    df["ema200"] = ta.ema(close, length=200)
    df["atr"] = ta.atr(high, low, close, length=14)
    # ATR as % of close — more meaningful than absolute ATR across price scales
    df["atr_pct"] = (df["atr"] / close) * 100.0
    # Volume ratio: current bar vs 20-bar SMA volume
    vol_sma20 = vol.rolling(window=20, min_periods=20).mean()
    df["vol_ratio"] = vol / vol_sma20

    # Replace NaN with None for JSON
    df = df.where(pd.notna(df), None)

    return df.to_dict(orient="records")


# ──────────────────────────────────────────────────────────────────────────────
# Zone crossing detector
# ──────────────────────────────────────────────────────────────────────────────

def detect_zone(bars_with_rsi: list[dict]) -> dict | None:
    """
    Given the last several bars (with .rsi populated), detect which zone, if any,
    has fired most recently within RECENCY_WINDOW_BARS for this timeframe.

    Returns: { "active": "<zone>", "fired_at_t": <ms>, "bars_ago": <int> } or None.

    Algorithm: scan bars from most-recent backward up to RECENCY_WINDOW_BARS deep.
    At each candidate "current" position N, check if a crossing fires using:
      - last CROSS_CONFIRM_BARS (positions N-1, N) all on the "after" side
      - at least CROSS_PRE_BARS_REQUIRED of positions N-4..N-2 on the "before" side
    Return the most recent crossing found.
    """
    if len(bars_with_rsi) < CROSS_LOOKBACK:
        return None

    n_total = len(bars_with_rsi)

    # Iterate candidate "current" bars from newest backward.
    # bars_with_rsi[-1] is bar N (newest); we want to check positions
    # n_total-1 (most recent) down to max(CROSS_LOOKBACK-1, n_total - max_window)
    max_window = max(RECENCY_WINDOW_BARS.values())  # caller-set timeframe; safe upper
    earliest_idx = max(CROSS_LOOKBACK - 1, n_total - max_window)

    for idx in range(n_total - 1, earliest_idx - 1, -1):
        # bar N = idx; bars N-4..N = idx-4..idx
        if idx - (CROSS_LOOKBACK - 1) < 0:
            continue
        window = bars_with_rsi[idx - (CROSS_LOOKBACK - 1) : idx + 1]
        rsis = [b.get("rsi") for b in window]
        if any(r is None for r in rsis):
            continue

        # window[-CROSS_CONFIRM_BARS:] are the "current/confirm" bars (positions N-1, N)
        confirm = rsis[-CROSS_CONFIRM_BARS:]
        # window[:-CROSS_CONFIRM_BARS] are the "pre" bars (positions N-4, N-3, N-2)
        pre = rsis[:-CROSS_CONFIRM_BARS]

        # Check each zone:
        # Bottom Done: pre had ≥2 below RSI_LOWER; confirm both ≥ RSI_LOWER
        if (
            sum(1 for r in pre if r < RSI_LOWER) >= CROSS_PRE_BARS_REQUIRED
            and all(r >= RSI_LOWER for r in confirm)
        ):
            return {"active": "bottom_done", "fired_at_t": window[-1]["t"], "bars_ago": n_total - 1 - idx}

        # Top Done: pre had ≥2 above RSI_UPPER; confirm both ≤ RSI_UPPER
        if (
            sum(1 for r in pre if r > RSI_UPPER) >= CROSS_PRE_BARS_REQUIRED
            and all(r <= RSI_UPPER for r in confirm)
        ):
            return {"active": "top_done", "fired_at_t": window[-1]["t"], "bars_ago": n_total - 1 - idx}

        # Bear Move Loading: pre had ≥2 above RSI_LOWER; confirm both < RSI_LOWER
        if (
            sum(1 for r in pre if r >= RSI_LOWER) >= CROSS_PRE_BARS_REQUIRED
            and all(r < RSI_LOWER for r in confirm)
        ):
            return {"active": "bear_load", "fired_at_t": window[-1]["t"], "bars_ago": n_total - 1 - idx}

        # Bull Move Loading: pre had ≥2 below RSI_UPPER; confirm both > RSI_UPPER
        if (
            sum(1 for r in pre if r <= RSI_UPPER) >= CROSS_PRE_BARS_REQUIRED
            and all(r > RSI_UPPER for r in confirm)
        ):
            return {"active": "bull_load", "fired_at_t": window[-1]["t"], "bars_ago": n_total - 1 - idx}

    return None


def filter_by_recency(zone: dict | None, timeframe: str) -> dict | None:
    """Drop the zone if it fired older than RECENCY_WINDOW_BARS[timeframe]."""
    if zone is None:
        return None
    if zone["bars_ago"] >= RECENCY_WINDOW_BARS[timeframe]:
        return None
    return zone
