/**
 * Takame TA / RSI pipeline — master-plan Layer 1 (admin-only by construction).
 *
 * Reads the admin-curated token universe from Supabase (`ta_universe`, public-read),
 * pulls real OHLCV candles from Binance (keyless, exact 1h/4h/1d/1w intervals),
 * computes RSI(Wilder-14) / EMA-stack / ATR / volume-ratio per timeframe, walks the
 * RSI zone state machine (9 states) and derives the Macro (Weekly×Daily) + Tactical
 * (Daily×1H) badges (10 badges) exactly per Plan_RSI System.txt, then writes
 * `public/data/ta_snapshots.json`.
 *
 * NO fabricated data — every number is computed from real candles. Tokens without a
 * Binance USDT pair (or with too little history) are emitted with null/UNSUPPORTED
 * fields, never invented values.
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

const BINANCE = 'https://api.binance.com/api/v3/klines';

type TF = '15m' | '1h' | '4h' | '1d' | '1w';
const TFS: TF[] = ['15m', '1h', '4h', '1d', '1w'];
const BINANCE_INTERVAL: Record<TF, string> = { '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w' };

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
 * Walk the RSI zone state machine on the RSI series. Returns the current state and a
 * count of recent failed re-entry attempts (for STRUCTURAL badges).
 */
function computeState(rsi: (number | null)[], z: { low: number; high: number; sustain: number }): { state: RSIState; failed: number } {
  const vals = rsi.filter((v): v is number => v != null);
  if (vals.length < z.sustain + 2) return { state: 'UNSUPPORTED', failed: 0 };
  const n = vals.length;
  const cur = vals[n - 1];

  if (cur >= z.high) return { state: 'HIGH_ZONE', failed: 0 };
  if (cur <= z.low) return { state: 'LOW_ZONE', failed: 0 };

  // In range: find the last candle that was inside a zone, and which zone.
  let lastZoneIdx = -1;
  let lastZoneKind: 'low' | 'high' | null = null;
  for (let i = n - 1; i >= 0; i--) {
    if (vals[i] <= z.low) { lastZoneIdx = i; lastZoneKind = 'low'; break; }
    if (vals[i] >= z.high) { lastZoneIdx = i; lastZoneKind = 'high'; break; }
  }
  if (lastZoneIdx === -1 || lastZoneKind == null) return { state: 'RANGE', failed: 0 };

  const sinceExit = n - 1 - lastZoneIdx; // candles since we were last in-zone
  // Count failed re-entries within a rolling recent window (structural pressure).
  const winStart = Math.max(1, n - 4 * z.sustain);
  let failed = 0;
  for (let i = winStart; i < n; i++) {
    if (lastZoneKind === 'low' && vals[i] <= z.low && vals[i - 1] > z.low) failed++;
    if (lastZoneKind === 'high' && vals[i] >= z.high && vals[i - 1] < z.high) failed++;
  }

  if (lastZoneKind === 'low') {
    if (sinceExit < z.sustain) return { state: 'EXITING_LOW', failed };
    return { state: 'CONFIRMED_BULL', failed };
  } else {
    if (sinceExit < z.sustain) return { state: 'EXITING_HIGH', failed };
    return { state: 'CONFIRMED_BEAR', failed };
  }
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

function deriveBadge(father: RSIState, son: RSIState, fatherFailed: number): BadgeName {
  if (father === 'CONFIRMED_BULL' && son === 'CONFIRMED_BULL') return 'BULL_ALIGNED';
  if (father === 'CONFIRMED_BEAR' && son === 'CONFIRMED_BEAR') return 'BEAR_ALIGNED';
  if (father === 'EXITING_LOW' && son === 'CONFIRMED_BULL') return 'EARLY_BULL';
  if (father === 'EXITING_HIGH' && son === 'CONFIRMED_BEAR') return 'EARLY_BEAR';
  if (father === 'LOW_ZONE' && son === 'EXITING_LOW') return 'BULL_FORMING';
  if (father === 'HIGH_ZONE' && son === 'EXITING_HIGH') return 'BEAR_FORMING';
  if (father === 'LOW_ZONE' && fatherFailed >= 2) return 'STRUCTURAL_BEAR';
  if (father === 'HIGH_ZONE' && fatherFailed >= 2) return 'STRUCTURAL_BULL';
  if ((father === 'CONFIRMED_BULL' && son === 'CONFIRMED_BEAR') || (father === 'CONFIRMED_BEAR' && son === 'CONFIRMED_BULL')) return 'DIVERGENCE';
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

async function fetchKlines(symbol: string, tf: TF, limit = 220): Promise<Candle[] | null> {
  const url = `${BINANCE}?symbol=${symbol}USDT&interval=${BINANCE_INTERVAL[tf]}&limit=${limit}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const raw = (await res.json()) as unknown[][];
    return raw.map((k) => ({ high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
  } catch {
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
    const sym = t.symbol.toUpperCase();
    const perTf: Record<string, Candle[] | null> = {};
    for (const tf of TFS) {
      perTf[tf] = await fetchKlines(sym, tf);
      await new Promise((r) => setTimeout(r, 120)); // gentle on Binance
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
    source: 'binance-klines',
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
