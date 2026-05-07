"""
A2 entrypoint. For each symbol in extra_symbols.json:
  - Load history (or backfill 300 bars if new)
  - Fetch incremental bars from Binance
  - Merge, recompute indicators on full series, trim to 250 bars
  - Detect zone crossings per timeframe with N-of-M filter + recency window
  - Reconcile: drop history entries for symbols no longer in extra_symbols.json

Writes data/ta_history.json (full state) and data/ta_snapshots.json (frontend view).
Hard-fails on any Binance error or schema violation — no commit lands.
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone

from _common import _read_extra_symbols, write_json_atomic
from _ta_helpers import (
    BACKFILL_BARS,
    INCREMENTAL_BARS,
    HISTORY_PATH,
    SNAPSHOTS_PATH,
    TIMEFRAMES,
    compute_indicators,
    detect_zone,
    fetch_klines,
    filter_by_recency,
    load_history,
    merge_bars,
)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _last_value(bars: list[dict], field: str):
    """Return the field of the last bar that has a non-None value, else None."""
    for b in reversed(bars):
        v = b.get(field)
        if v is not None:
            return v
    return None


def main() -> None:
    symbols = _read_extra_symbols()
    symbols_lc = {s.lower() for s in symbols}
    print(f"[ta] symbols: {symbols}", file=sys.stderr)

    history = load_history()

    # Reconcile: drop entries for symbols no longer in extra_symbols.json
    dropped = [k for k in history.keys() if k not in symbols_lc]
    for k in dropped:
        del history[k]
    if dropped:
        print(f"[ta] dropped removed symbols: {dropped}", file=sys.stderr)

    # Update each symbol × timeframe
    for sym in symbols:
        sym_lc = sym.lower()
        if sym_lc not in history:
            history[sym_lc] = {}
        for tf in TIMEFRAMES:
            existing = history[sym_lc].get(tf, {}).get("bars", [])
            if not existing:
                # New symbol or new timeframe → backfill
                print(f"[ta] backfill {sym} {tf} ({BACKFILL_BARS} bars)", file=sys.stderr)
                fresh = fetch_klines(sym, tf, BACKFILL_BARS)
                merged = merge_bars([], fresh)
            else:
                fresh = fetch_klines(sym, tf, INCREMENTAL_BARS)
                merged = merge_bars(existing, fresh)

            with_indicators = compute_indicators(merged)
            history[sym_lc][tf] = {
                "last_fetched_utc": _utc_now_iso(),
                "bars": with_indicators,
            }

    # Build snapshots view
    snapshots: dict[str, dict] = {}
    for sym in symbols:
        sym_lc = sym.lower()
        sym_snap: dict = {
            "rsi": {}, "ema": {}, "atr_pct": {}, "vol_ratio": {}, "zones": {}
        }
        for tf in TIMEFRAMES:
            bars = history[sym_lc][tf]["bars"]
            sym_snap["rsi"][tf] = _last_value(bars, "rsi")
            sym_snap["ema"][tf] = {
                "ema20": _last_value(bars, "ema20"),
                "ema50": _last_value(bars, "ema50"),
                "ema200": _last_value(bars, "ema200"),
            }
            sym_snap["atr_pct"][tf] = _last_value(bars, "atr_pct")
            sym_snap["vol_ratio"][tf] = _last_value(bars, "vol_ratio")
            zone = detect_zone(bars)
            zone = filter_by_recency(zone, tf)
            if zone is None:
                sym_snap["zones"][tf] = {
                    "active": None, "fired_at_utc": None, "bars_ago": None
                }
            else:
                fired_iso = datetime.fromtimestamp(
                    zone["fired_at_t"] / 1000, tz=timezone.utc
                ).strftime("%Y-%m-%dT%H:%M:%SZ")
                sym_snap["zones"][tf] = {
                    "active": zone["active"],
                    "fired_at_utc": fired_iso,
                    "bars_ago": zone["bars_ago"],
                }
        snapshots[sym_lc] = sym_snap

    write_json_atomic(HISTORY_PATH, history)
    write_json_atomic(SNAPSHOTS_PATH, {
        "generated_at_utc": _utc_now_iso(),
        "symbol_count": len(snapshots),
        "timeframes": TIMEFRAMES,
        "symbols": snapshots,
    })
    print(
        f"[ta] wrote {HISTORY_PATH} ({len(history)} symbols) "
        f"and {SNAPSHOTS_PATH} ({len(snapshots)} symbols)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
