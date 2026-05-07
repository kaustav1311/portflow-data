"""
A1 entrypoint. Fetches prices for symbols in portflow-private/extra_symbols.json
from CoinGecko, writes data/prices.json. Hard-fails on any error — no commit
will land if this exits non-zero.
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone

from _common import _read_extra_symbols, _safe_float, coingecko_get, write_json_atomic

OUTPUT_PATH = "data/prices.json"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _resolve_symbols_to_ids(symbols: list[str]) -> dict[str, str]:
    """
    CoinGecko's /coins/markets needs CoinGecko IDs (e.g. 'bitcoin'), not symbols.
    /coins/list is keyless and gives the full mapping. Single call, in-memory filter.
    """
    print(f"[prices] resolving {len(symbols)} symbols to CoinGecko IDs", file=sys.stderr)
    coins = coingecko_get("/coins/list", params={})
    if not isinstance(coins, list):
        raise RuntimeError("/coins/list returned unexpected shape")

    wanted = {s.upper() for s in symbols}
    by_symbol: dict[str, str] = {}

    # Multiple coins can share a symbol (e.g. dozens of "BTC" scams). We pick by
    # market_cap_rank later via /coins/markets — but to do that, we need *some*
    # candidate set. Strategy: collect all matches, dedupe by id, ask /coins/markets
    # for all candidates, keep the one with the lowest rank per symbol.
    candidates: dict[str, list[str]] = {s: [] for s in wanted}
    for c in coins:
        sym = c.get("symbol", "").upper()
        cid = c.get("id")
        if sym in wanted and cid:
            candidates[sym].append(cid)

    missing = [s for s, ids in candidates.items() if not ids]
    if missing:
        raise RuntimeError(f"CoinGecko has no coins for symbols: {missing}")

    # Flatten all candidate ids; we'll resolve ambiguity in the markets call.
    all_ids = sorted({cid for ids in candidates.values() for cid in ids})
    return candidates, all_ids


def _fetch_markets(all_ids: list[str]) -> list[dict]:
    """One /coins/markets call. Per-page=250 max; chunk if needed."""
    out: list[dict] = []
    page_size = 250
    for i in range(0, len(all_ids), page_size):
        chunk = all_ids[i : i + page_size]
        params = {
            "vs_currency": "usd",
            "ids": ",".join(chunk),
            "order": "market_cap_desc",
            "per_page": page_size,
            "page": 1,
            "sparkline": "false",
            "price_change_percentage": "24h",
        }
        data = coingecko_get("/coins/markets", params=params)
        if not isinstance(data, list):
            raise RuntimeError("/coins/markets returned unexpected shape")
        out.extend(data)
    return out


def main() -> None:
    symbols = _read_extra_symbols()
    print(f"[prices] symbols: {symbols}", file=sys.stderr)

    candidates, all_ids = _resolve_symbols_to_ids(symbols)
    markets = _fetch_markets(all_ids)

    # Pick the highest-ranked coin per symbol (lowest market_cap_rank).
    # Ties or missing rank → take first by market cap descending (already sorted).
    by_id = {m["id"]: m for m in markets}
    chosen: dict[str, dict] = {}

    for sym in symbols:
        ids = candidates[sym]
        ranked: list[tuple[int, dict]] = []
        for cid in ids:
            m = by_id.get(cid)
            if not m:
                continue
            rank = m.get("market_cap_rank") or 10**9  # unranked → push to bottom
            ranked.append((rank, m))
        if not ranked:
            raise RuntimeError(f"No /coins/markets entry for {sym} (candidates: {ids})")
        ranked.sort(key=lambda x: x[0])
        chosen[sym] = ranked[0][1]

    # Build output. Validate every numeric field — no fabricated data.
    prices: dict[str, dict] = {}
    for sym, m in chosen.items():
        price = _safe_float(m.get("current_price"))
        if price is None:
            raise RuntimeError(f"{sym}: current_price is null/invalid")
        prices[sym.lower()] = {
            "symbol": sym,
            "price_usd": price,
            "change_24h_pct": _safe_float(m.get("price_change_percentage_24h")),
            "vol_24h_usd": _safe_float(m.get("total_volume")),
            "mcap_usd": _safe_float(m.get("market_cap")),
            "rank": m.get("market_cap_rank"),
        }

    output = {
        "generated_at_utc": _utc_now_iso(),
        "source": "coingecko",
        "count": len(prices),
        "prices": prices,
    }

    write_json_atomic(OUTPUT_PATH, output)
    print(f"[prices] wrote {OUTPUT_PATH} with {len(prices)} symbols", file=sys.stderr)


if __name__ == "__main__":
    main()
