/**
 * Takame TA / RSI pipeline — master-plan Layer 1 (admin-only by construction).
 *
 * Reads the admin-curated token universe from Supabase (`ta_universe`, public-read),
 * pulls real OHLCV candles from OKX's public spot API (keyless, exact
 * 15m/1H/4H/1D/1W bars), computes RSI(Wilder-14) / EMA-stack / ATR / volume-ratio
 * per timeframe, walks the RSI zone state machine (9 states) and derives the Macro
 * (Weekly×Daily) + Tactical (Daily×1H) badges (10 badges) exactly per
 * Plan_RSI System.txt, then writes `public/data/ta_snapshots.json`.
 *
 * NO fabricated data — every number is computed from real candles. Tokens without
 * a spot pair (or with too little history) are emitted with null/UNSUPPORTED
 * fields, never invented values.
 *
 * Candle source is Kucoin. History of this line, so this doesn't get re-swapped
 * next time without evidence:
 *   • Binance was tried first — blocked GH Actions IP ranges.
 *   • Bybit was tried next — ALSO blocked (its Cloudfront distribution rejects
 *     the same datacentre IPs; CI diag: "The Amazon CloudFront distribution is
 *     configured to block access from your country").
 *   • OKX was tried — not verifiable from the user's India connection (TLS reset
 *     at their ISP), and OKX has known US access restrictions that would likely
 *     bite CI too.
 * Kucoin's public market-data API is globally reachable (verified from the
 * user's blocked network AND has no known US datacentre restriction), and it
 * covers all five timeframes we need: 15min / 1hour / 4hour / 1day / 1week.
 *
 * GOTCHA: Kucoin's kline columns are [ts, open, CLOSE, high, low, vol, turnover]
 * — close before high/low, unlike Binance/Bybit/OKX. Don't mis-map.
 *
 * Run locally:  SUPABASE_URL=.. SUPABASE_ANON_KEY=.. npx tsx pipeline/ta_pipeline.ts
 * In CI: see .github/workflows/ta-snapshots.yml
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const OUT_PATH = process.env.TA_OUT || 'public/data/ta_snapshots.json';

const KUCOIN = 'https://api.kucoin.com/api/v1/market/candles';
const HL_INFO = 'https://api.hyperliquid.xyz/info';

type TF = '15m' | '1h' | '4h' | '1d' | '1w';
const TFS: TF[] = ['15m', '1h', '4h', '1d', '1w'];
// Kucoin's `type` values (see docs). Different vocabulary from every other
// exchange we've tried, hence the explicit map.
const KUCOIN_TYPE: Record<TF, string> = { '15m': '15min', '1h': '1hour', '4h': '4hour', '1d': '1day', '1w': '1week' };
// Hyperliquid intervals — vocabulary matches ours except HL uses '1w' too. Bar-ms
// used to size the startTime window so RSI(14)+EMA(34) settle (~200 bars).
const HL_INTERVAL: Record<TF, string> = { '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w' };
const HL_BAR_MS: Record<TF, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000 };

// Zone thresholds per Plan_RSI System.txt (Weekly/Daily/1H are the spec's badge pairs).
// 4h/15m are shown for context and tightened as the timeframe shortens (more noise).
const ZONES: Record<TF, { low: number; high: number; deepLow: number; deepHigh: number; sustain: number }> = {
  '1w': { low: 40, high: 60, deepLow: 30, deepHigh: 70, sustain: 2 },
  '1d': { low: 36, high: 64, deepLow: 25, deepHigh: 75, sustain: 3 },
  '4h': { low: 33, high: 67, deepLow: 22, deepHigh: 78, sustain: 3 },
  '1h': { low: 30, high: 70, deepLow: 20, deepHigh: 80, sustain: 4 },
  '15m': { low: 25, high: 75, deepLow: 18, deepHigh: 82, sustain: 4 },
};

type RSIState =
  | 'HIGH_ZONE' | 'LOW_ZONE' | 'RANGE'
  | 'EXITING_HIGH' | 'EXITING_LOW'
  | 'CONFIRMED_BULL' | 'CONFIRMED_BEAR'
  | 'FAILED_BOTTOM' | 'FAILED_TOP'
  | 'UNSUPPORTED';

// ---------------------------------------------------------------------------
// Indicator math
// ---------------------------------------------------------------------------

/** Wilder RSI series aligned to closes (first `period` entries are null). */
function rsiSeries(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function atrWilder(highs: number[], lows: number[], closes: number[], period = 14): number | null {
  if (closes.length <= period) return null;
  const tr: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}

function emaStack(closes: number[]): 'BULLISH' | 'BEARISH' | 'MIXED' | null {
  const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50);
  if (e9 == null || e21 == null || e50 == null) return null;
  if (e9 > e21 && e21 > e50) return 'BULLISH';
  if (e9 < e21 && e21 < e50) return 'BEARISH';
  return 'MIXED';
}

function rsiDirection(cur: number | null, p1: number | null): RSIState extends never ? never : string | null {
  if (cur == null || p1 == null) return null;
  const d = cur - p1;
  if (d > 3) return 'CLIMBING';
  if (d > 0.2) return 'RISING';
  if (d < -3) return 'DROPPING';
  if (d < -0.2) return 'FALLING';
  return 'FLAT';
}

/**
 * Zone state machine — reworked 2026-07-20 to match the user's spec:
 *   "Entering 40 from below = Bottom Done, entering 60 from above = Top Done,
 *    RSI sustained above 60 for K bars = Bull Trend, below 40 for K = Bear Trend."
 *
 * State semantics (names kept for backward compat with existing frontend UI):
 *   CONFIRMED_BULL → RSI has stayed above `high` for K=sustain consecutive bars (real bull trend).
 *   CONFIRMED_BEAR → RSI has stayed below `low`  for K=sustain consecutive bars (real bear trend).
 *   HIGH_ZONE      → currently above `high`, not yet sustained (single touch).
 *   LOW_ZONE       → currently below `low`,  not yet sustained.
 *   EXITING_HIGH   → RSI in the 40–60 band, most recent zone touch (within lookback) was HIGH → "Top Done".
 *   EXITING_LOW    → RSI in the 40–60 band, most recent zone touch (within lookback) was LOW  → "Bottom Done".
 *   RANGE          → no recent zone touch at all.
 *
 * This replaces the older "last-zone-visited wins regardless of how long ago" logic,
 * which produced misleading labels like BTC 4H CONFIRMED_BEAR at RSI 59.68.
 */
function computeState(rsi: (number | null)[], z: { low: number; high: number; sustain: number }): { state: RSIState; failed: number } {
  const vals = rsi.filter((v): v is number => v != null);
  if (vals.length < z.sustain + 2) return { state: 'UNSUPPORTED', failed: 0 };
  const n = vals.length;
  const cur = vals[n - 1];
  const K = z.sustain;

  // Sustained-trend check: currently in a zone AND has been for K consecutive bars.
  if (cur >= z.high) {
    const sustainedHigh = vals.slice(-K).every((v) => v >= z.high);
    if (sustainedHigh) return { state: 'CONFIRMED_BULL', failed: 0 };
    return { state: 'HIGH_ZONE', failed: 0 };
  }
  if (cur <= z.low) {
    const sustainedLow = vals.slice(-K).every((v) => v <= z.low);
    if (sustainedLow) return { state: 'CONFIRMED_BEAR', failed: 0 };
    return { state: 'LOW_ZONE', failed: 0 };
  }

  // Mid-band: look for the most-recent zone touch within a "recent enough" window
  // to distinguish a fresh crossing (EXITING_*) from plain RANGE.
  const window = K * 3;
  const winStart = Math.max(0, n - window);
  let lastZoneIdx = -1;
  let lastZoneKind: 'low' | 'high' | null = null;
  for (let i = n - 1; i >= winStart; i--) {
    if (vals[i] <= z.low) { lastZoneIdx = i; lastZoneKind = 'low'; break; }
    if (vals[i] >= z.high) { lastZoneIdx = i; lastZoneKind = 'high'; break; }
  }
  if (lastZoneIdx === -1 || lastZoneKind == null) return { state: 'RANGE', failed: 0 };

  // Rolling failed-re-entry count for STRUCTURAL badges (unchanged from prior logic).
  let failed = 0;
  for (let i = Math.max(1, n - 4 * K); i < n; i++) {
    if (lastZoneKind === 'low' && vals[i] <= z.low && vals[i - 1] > z.low) failed++;
    if (lastZoneKind === 'high' && vals[i] >= z.high && vals[i - 1] < z.high) failed++;
  }

  return {
    state: lastZoneKind === 'low' ? 'EXITING_LOW' : 'EXITING_HIGH',
    failed,
  };
}

// Re-entry (FAILED) detection: exited a zone then came back within sustain window.
function refineFailed(rsi: (number | null)[], z: { low: number; high: number; sustain: number }, base: RSIState): RSIState {
  const vals = rsi.filter((v): v is number => v != null);
  const n = vals.length;
  const cur = vals[n - 1];
  // Only meaningful when currently in range near a zone edge.
  if (cur >= z.high || cur <= z.low) return base;
  // Look back sustain*2 candles for exit→re-entry→exit pattern.
  const look = Math.min(n, z.sustain * 2 + 2);
  let touchedLow = false, touchedHigh = false, leftLow = false, leftHigh = false;
  for (let i = n - look; i < n; i++) {
    if (i < 1) continue;
    if (vals[i] <= z.low) { touchedLow = true; leftLow = false; }
    else if (touchedLow && vals[i] > z.low) leftLow = true;
    if (vals[i] >= z.high) { touchedHigh = true; leftHigh = false; }
    else if (touchedHigh && vals[i] < z.high) leftHigh = true;
  }
  if (touchedLow && leftLow) {
    // did it dip back to low after leaving, within window?
    let reentered = false, exitedOnce = false;
    for (let i = n - look; i < n; i++) { if (i < 0) continue; if (vals[i] <= z.low && exitedOnce) reentered = true; if (vals[i] > z.low) exitedOnce = true; }
    if (reentered) return 'FAILED_BOTTOM';
  }
  if (touchedHigh && leftHigh) {
    let reentered = false, exitedOnce = false;
    for (let i = n - look; i < n; i++) { if (i < 0) continue; if (vals[i] >= z.high && exitedOnce) reentered = true; if (vals[i] < z.high) exitedOnce = true; }
    if (reentered) return 'FAILED_TOP';
  }
  return base;
}

// ---------------------------------------------------------------------------
// Badge derivation — father × son per Plan_RSI System.txt
// ---------------------------------------------------------------------------

type BadgeName =
  | 'BULL_ALIGNED' | 'BEAR_ALIGNED' | 'EARLY_BULL' | 'EARLY_BEAR'
  | 'BULL_FORMING' | 'BEAR_FORMING' | 'STRUCTURAL_BULL' | 'STRUCTURAL_BEAR'
  | 'DIVERGENCE' | 'NEUTRAL';

/**
 * Score-based badge derivation — 2026-07-23 rewrite.
 *
 * The prior table only fired for ~9 specific combos. HIP-3 equities spend most
 * of their time in RANGE × EXITING_* combos (see `xyz:AMZN` in the field), which
 * ALL fell through to NEUTRAL — so every stock read "no signal" regardless of
 * what was actually happening. This scores father and son independently and
 * synthesises the verdict, so any state combo produces a meaningful read while
 * the original spec-cases keep their exact labels.
 *
 * Per-state contribution:
 *   CONFIRMED_BULL  +2   sustained above high
 *   CONFIRMED_BEAR  -2
 *   EXITING_LOW     +1   fresh cross up from oversold
 *   EXITING_HIGH    -1   fresh cross down from overbought
 *   LOW_ZONE        -0.5 currently oversold, not yet sustained
 *   HIGH_ZONE       +0.5 currently overbought, not yet sustained
 *   RANGE / other    0
 *
 * Father carries 2× weight (macro > tactical). Failed re-entries on the father
 * still promote to STRUCTURAL_* — those are the "trend keeps breaking" reads
 * and dominate other signals when they fire. DIVERGENCE reserved for hard
 * father-vs-son opposition (CONFIRMED_BULL × CONFIRMED_BEAR or the mirror).
 */
function stateScore(s: RSIState): number {
  switch (s) {
    case 'CONFIRMED_BULL': return 2;
    case 'CONFIRMED_BEAR': return -2;
    case 'EXITING_LOW': return 1;
    case 'EXITING_HIGH': return -1;
    case 'LOW_ZONE': return -0.5;
    case 'HIGH_ZONE': return 0.5;
    default: return 0;
  }
}

function deriveBadge(father: RSIState, son: RSIState, fatherFailed: number): BadgeName {
  // Structural (father's zone keeps breaking) wins outright — it's the strongest
  // multi-bar read available and shouldn't get diluted by a mid-band son.
  if (father === 'LOW_ZONE' && fatherFailed >= 2) return 'STRUCTURAL_BEAR';
  if (father === 'HIGH_ZONE' && fatherFailed >= 2) return 'STRUCTURAL_BULL';

  // Hard divergence — sustained conflict between the two timeframes.
  if (father === 'CONFIRMED_BULL' && son === 'CONFIRMED_BEAR') return 'DIVERGENCE';
  if (father === 'CONFIRMED_BEAR' && son === 'CONFIRMED_BULL') return 'DIVERGENCE';

  const score = stateScore(father) * 2 + stateScore(son);

  // Preserve the exact original spec labels for the canonical combos —
  // downstream UIs and prior memories reference these strings verbatim.
  if (father === 'CONFIRMED_BULL' && son === 'CONFIRMED_BULL') return 'BULL_ALIGNED';
  if (father === 'CONFIRMED_BEAR' && son === 'CONFIRMED_BEAR') return 'BEAR_ALIGNED';
  if (father === 'EXITING_LOW' && son === 'CONFIRMED_BULL') return 'EARLY_BULL';
  if (father === 'EXITING_HIGH' && son === 'CONFIRMED_BEAR') return 'EARLY_BEAR';
  if (father === 'LOW_ZONE' && son === 'EXITING_LOW') return 'BULL_FORMING';
  if (father === 'HIGH_ZONE' && son === 'EXITING_HIGH') return 'BEAR_FORMING';

  // Score-driven fallback for everything else.
  //   ≥ 3.5    → BULL_ALIGNED   (confirmed macro + supporting son)
  //   1.5–3.5  → EARLY_BULL     (one leg strong bull, other neutral/mild)
  //   0.5–1.5  → BULL_FORMING   (light bullish lean)
  //   -0.5–0.5 → NEUTRAL
  //   -1.5–-0.5→ BEAR_FORMING
  //   -3.5–-1.5→ EARLY_BEAR
  //   ≤ -3.5   → BEAR_ALIGNED
  if (score >= 3.5) return 'BULL_ALIGNED';
  if (score >= 1.5) return 'EARLY_BULL';
  if (score >= 0.5) return 'BULL_FORMING';
  if (score <= -3.5) return 'BEAR_ALIGNED';
  if (score <= -1.5) return 'EARLY_BEAR';
  if (score <= -0.5) return 'BEAR_FORMING';
  return 'NEUTRAL';
}

// ---------------------------------------------------------------------------
// Data fetch
// ---------------------------------------------------------------------------

interface UniverseToken { coin_id: string; symbol: string; name: string; image: string | null; }

async function loadUniverse(): Promise<UniverseToken[]> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY not set — cannot read ta_universe');
  }
  const url = `${SUPABASE_URL}/rest/v1/ta_universe?select=coin_id,symbol,name,image&active=eq.true&order=sort_order.asc`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
  if (!res.ok) throw new Error(`ta_universe fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

interface Candle { high: number; low: number; close: number; volume: number; }

// Log the FIRST failure only, so the CI log tells us what actually happened
// (blocked / rate-limited / bad response) without spamming 65 lines per run.
// Remove this flag + the two console.error calls once the real cause is known.
let loggedFailure = false;

function isHip3Ticker(symbol: string): boolean {
  return typeof symbol === 'string' && symbol.includes(':');
}

// Hyperliquid `/info candleSnapshot` for HIP-3 markets (equities/commodities/FX
// listed on builder-deployed dexes like `xyz:AMZN`, `xyz:GOLD`). Frontend ⟳ has
// used this since 2026-07-21 (`services/liveIndicators.ts`); this brings the
// pipeline in line so those rows land in the snapshot instead of `UNSUPPORTED`.
// HL row shape: `{t, T, s, i, o, c, h, l, v, n}` — c/h/l/v arrive as STRINGS.
async function fetchHlKlines(coin: string, tf: TF): Promise<Candle[] | null> {
  const now = Date.now();
  const startTime = now - HL_BAR_MS[tf] * 200;
  try {
    const res = await fetch(HL_INFO, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: HL_INTERVAL[tf], startTime, endTime: now } }),
    });
    if (!res.ok) {
      if (!loggedFailure) {
        loggedFailure = true;
        console.error(`[diag hl] ${coin} ${tf} -> HTTP ${res.status} ${res.statusText}; body: ${(await res.text()).slice(0, 300)}`);
      }
      return null;
    }
    const rows = (await res.json()) as Array<{ o: string; c: string; h: string; l: string; v: string }> | null;
    if (!Array.isArray(rows) || rows.length === 0) {
      if (!loggedFailure) {
        loggedFailure = true;
        console.error(`[diag hl] ${coin} ${tf} -> empty candleSnapshot (market may not trade)`);
      }
      return null;
    }
    // HL ships oldest-first — no reverse.
    return rows
      .map((k) => ({ high: +k.h, low: +k.l, close: +k.c, volume: +k.v }))
      .filter((c) => Number.isFinite(c.close) && Number.isFinite(c.high) && Number.isFinite(c.low));
  } catch (e) {
    if (!loggedFailure) {
      loggedFailure = true;
      console.error(`[diag hl] ${coin} ${tf} -> threw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
    return null;
  }
}

async function fetchKlines(symbol: string, tf: TF, limit = 200): Promise<Candle[] | null> {
  // HIP-3 tickers (namespaced coin ids like `xyz:AMZN`) don't exist on Kucoin —
  // route them straight to Hyperliquid. Everything else stays on Kucoin.
  if (isHip3Ticker(symbol)) return fetchHlKlines(symbol, tf);
  // Kucoin uses `BASE-QUOTE` pair ids. `limit` isn't a query param — the
  // endpoint returns up to 1500 klines by default; we don't ask for more.
  void limit;
  const url = `${KUCOIN}?symbol=${symbol}-USDT&type=${KUCOIN_TYPE[tf]}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      if (!loggedFailure) {
        loggedFailure = true;
        console.error(`[diag] ${symbol} ${tf} -> HTTP ${res.status} ${res.statusText}; body: ${(await res.text()).slice(0, 300)}`);
      }
      return null;
    }
    // Kucoin response: { code: "200000", data: [[ts, open, close, high, low, vol, turnover], ...] }
    const json = (await res.json()) as { code: string; msg?: string; data?: string[][] };
    if (json.code !== '200000' || !json.data?.length) {
      if (!loggedFailure) {
        loggedFailure = true;
        console.error(`[diag] ${symbol} ${tf} -> code=${json.code} msg=${json.msg} data=${json.data?.length ?? 'none'}`);
      }
      return null;
    }
    // Kucoin returns newest-first; downstream calcs walk oldest→newest, so
    // reverse before mapping. Column order is [ts, o, c, h, l, vol, turnover] —
    // close is index 2, high is 3, low is 4. See file header GOTCHA.
    const rows = [...json.data].reverse();
    return rows.map((k) => ({ high: +k[3], low: +k[4], close: +k[2], volume: +k[5] }));
  } catch (e) {
    if (!loggedFailure) {
      loggedFailure = true;
      console.error(`[diag] ${symbol} ${tf} -> threw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
    return null;
  }
}

function analyseTF(candles: Candle[] | null, tf: TF, computedAt: string) {
  if (!candles || candles.length < 30) {
    return { rsi: null, rsi_prev1: null, rsi_prev2: null, rsi_direction: null, ema_stack: null, atr: null, atr_pct: null, vol_ratio: null, state: 'UNSUPPORTED' as RSIState, failed: 0, computed_at: computedAt };
  }
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const vols = candles.map((c) => c.volume);
  const rsi = rsiSeries(closes);
  const nn = rsi.filter((v): v is number => v != null);
  const cur = nn[nn.length - 1] ?? null;
  const p1 = nn[nn.length - 2] ?? null;
  const p2 = nn[nn.length - 3] ?? null;
  const z = ZONES[tf];
  const st = computeState(rsi, z);
  const state = st.state === 'EXITING_LOW' || st.state === 'EXITING_HIGH' ? refineFailed(rsi, z, st.state) : st.state;
  const atr = atrWilder(highs, lows, closes);
  const lastClose = closes[closes.length - 1];
  const volSma = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vols.length);
  return {
    rsi: cur != null ? +cur.toFixed(2) : null,
    rsi_prev1: p1 != null ? +p1.toFixed(2) : null,
    rsi_prev2: p2 != null ? +p2.toFixed(2) : null,
    rsi_direction: rsiDirection(cur, p1),
    ema_stack: tf === '1w' ? emaStack(closes) : emaStack(closes),
    atr: atr != null ? +atr.toFixed(6) : null,
    atr_pct: atr != null && lastClose ? +((atr / lastClose) * 100).toFixed(2) : null,
    vol_ratio: volSma ? +(vols[vols.length - 1] / volSma).toFixed(2) : null,
    state,
    failed: st.failed,
    computed_at: computedAt,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const computedAt = new Date().toISOString();
  const universe = await loadUniverse();
  console.log(`Universe: ${universe.length} tokens`);

  const tokens: unknown[] = [];
  for (const t of universe) {
    // Preserve original casing for HIP-3 tickers — HL expects `xyz:AMZN`, not
    // `XYZ:AMZN`. Uppercase only regular crypto symbols for Kucoin.
    const sym = isHip3Ticker(t.symbol) ? t.symbol : t.symbol.toUpperCase();
    const perTf: Record<string, Candle[] | null> = {};
    for (const tf of TFS) {
      perTf[tf] = await fetchKlines(sym, tf);
      await new Promise((r) => setTimeout(r, 120)); // gentle on Kucoin (public tier)
    }
    const ta: Record<string, ReturnType<typeof analyseTF>> = {};
    for (const tf of TFS) ta[tf] = analyseTF(perTf[tf], tf, computedAt);

    const supported = TFS.some((tf) => ta[tf].state !== 'UNSUPPORTED');
    const lastClose = perTf['1h']?.at(-1)?.close ?? perTf['1d']?.at(-1)?.close ?? null;

    // Macro = Weekly(father) × Daily(son); Tactical = Daily(father) × 1H(son)
    const macro = deriveBadge(ta['1w'].state, ta['1d'].state, ta['1w'].failed);
    const tactical = deriveBadge(ta['1d'].state, ta['1h'].state, ta['1d'].failed);

    tokens.push({
      coin_id: t.coin_id,
      symbol: t.symbol,
      name: t.name,
      image: t.image,
      price: lastClose,
      supported,
      ta: Object.fromEntries(TFS.map((tf) => [tf, { ...ta[tf], failed: undefined }])),
      badges: {
        macro: { badge_name: macro, father_state: ta['1w'].state, son_state: ta['1d'].state, failed_attempts: ta['1w'].failed },
        tactical: { badge_name: tactical, father_state: ta['1d'].state, son_state: ta['1h'].state, failed_attempts: ta['1d'].failed },
      },
    });
    console.log(`  ${sym.padEnd(6)} macro=${macro} tactical=${tactical} 1d.rsi=${ta['1d'].rsi ?? '—'} state=${ta['1d'].state}`);
  }

  const payload = {
    generated_at: computedAt,
    source: 'kucoin-klines',
    timeframes: TFS,
    zones: ZONES,
    token_count: tokens.length,
    tokens,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${OUT_PATH} (${tokens.length} tokens)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
