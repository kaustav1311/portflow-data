"""
Shared helpers for portflow-data workflow scripts.

Used by both prices.py (A1) and compute_ta.py (A2).
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any

import requests

EXTRA_SYMBOLS_URL = (
    "https://api.github.com/repos/{owner}/portflow-private"
    "/contents/data/extra_symbols.json"
)
SYMBOL_HARD_CAP = 100


def _safe_float(v: Any) -> float | None:
    """
    Defensive float coercion. Mirrors Signal Agent's _safe_float lesson:
    truthiness guards on price floats fail silently for small numbers.
    """
    if v is None:
        return None
    if isinstance(v, (int, float)):
        if v != v:  # NaN check without importing math
            return None
        return float(v)
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _read_extra_symbols() -> list[str]:
    """
    Read symbol universe from portflow-private/data/extra_symbols.json
    via the GitHub Contents API. Hard-fails on read error or cap breach.

    Returns: list of uppercase ticker strings, e.g. ["BTC", "ETH", "SOL"]
    """
    pat = os.environ.get("GH_READ_PAT")
    owner = os.environ.get("GITHUB_REPOSITORY_OWNER")
    if not pat:
        raise RuntimeError("GH_READ_PAT not set in env")
    if not owner:
        raise RuntimeError("GITHUB_REPOSITORY_OWNER not set in env")

    url = EXTRA_SYMBOLS_URL.format(owner=owner)
    headers = {
        "Authorization": f"Bearer {pat}",
        "Accept": "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    r = requests.get(url, headers=headers, timeout=15)
    if r.status_code != 200:
        raise RuntimeError(
            f"extra_symbols.json fetch failed: HTTP {r.status_code} — {r.text[:200]}"
        )

    try:
        symbols = json.loads(r.text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"extra_symbols.json invalid JSON: {e}")

    if not isinstance(symbols, list) or not all(isinstance(s, str) for s in symbols):
        raise RuntimeError("extra_symbols.json must be a flat list of strings")

    symbols = [s.strip().upper() for s in symbols if s.strip()]

    if len(symbols) == 0:
        raise RuntimeError("extra_symbols.json is empty")
    if len(symbols) > SYMBOL_HARD_CAP:
        raise RuntimeError(
            f"extra_symbols.json has {len(symbols)} entries; hard cap is {SYMBOL_HARD_CAP}"
        )

    # Deterministic order matters for reproducible JSON output
    return sorted(set(symbols))


def coingecko_get(path: str, params: dict[str, Any]) -> dict | list:
    """
    CoinGecko fetch with free-first, key-fallback policy.

    1. Try public endpoint (api.coingecko.com), no auth.
    2. On 429 or 5xx, retry once on Pro endpoint if COINGECKO_KEY is set.
    3. Otherwise, raise — no fabricated data.
    """
    public_url = f"https://api.coingecko.com/api/v3{path}"
    pro_url = f"https://pro-api.coingecko.com/api/v3{path}"

    r = requests.get(public_url, params=params, timeout=20)

    if r.status_code == 200:
        print(f"  [coingecko] free endpoint OK ({path})", file=sys.stderr)
        return r.json()

    if r.status_code in (429,) or 500 <= r.status_code < 600:
        key = os.environ.get("COINGECKO_KEY")
        if key:
            print(
                f"  [coingecko] free returned {r.status_code}; retrying on Pro",
                file=sys.stderr,
            )
            headers = {"x-cg-pro-api-key": key}
            r2 = requests.get(pro_url, params=params, headers=headers, timeout=20)
            if r2.status_code == 200:
                print(f"  [coingecko] Pro endpoint OK ({path})", file=sys.stderr)
                return r2.json()
            raise RuntimeError(
                f"CoinGecko Pro fallback failed: HTTP {r2.status_code} — {r2.text[:200]}"
            )
        raise RuntimeError(
            f"CoinGecko free returned {r.status_code} and no COINGECKO_KEY set for fallback"
        )

    raise RuntimeError(f"CoinGecko free returned HTTP {r.status_code} — {r.text[:200]}")


def write_json_atomic(path: str, data: dict) -> None:
    """
    Write JSON to path via tmp-then-rename. Prevents half-written files
    if the process dies mid-write (cron runners do get killed).
    """
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=False, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)
