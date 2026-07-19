# Takame TA List pipeline (portable)

Computes the RSI state-machine TA for the **admin-curated token universe** and publishes
`ta_snapshots.json`. Master-plan **Layer 1** (admin-only by construction: only maintainers
of the host repo can change what it runs). Every number comes from **real Binance candles** —
nothing is fabricated. Tokens without a Binance `<SYMBOL>USDT` pair are emitted `UNSUPPORTED`.

**This folder is self-contained** — drop it into any existing repo you own and it runs on GitHub
Actions with only Node. Nothing here depends on the Takame app.

## What it does

1. Reads active rows from Supabase `ta_universe` (public-read; anon key is enough).
2. Pulls Binance klines for `1h/4h/1d/1w`.
3. Computes Wilder RSI(14), EMA(9/21/50) stack, ATR(14), volume ratio per timeframe.
4. Walks the 9-state RSI zone machine and derives the 10 Macro (Weekly×Daily) + Tactical
   (Daily×1H) badges (thresholds per `Plan_RSI System.txt`).
5. Writes the snapshot JSON (default `ta_snapshots.json` in the repo root; override with `TA_OUT`).

## Drop into your existing repo

1. Copy this `pipeline/` folder to the repo root.
2. Copy `pipeline/ta-snapshots.workflow.yml` to `.github/workflows/ta-snapshots.yml`.
3. Repo → Settings → Secrets and variables → Actions → add:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
4. The Action runs hourly (and on demand) and commits `ta_snapshots.json`.
5. In the Takame app, set `VITE_TA_SNAPSHOT_URL` to the raw URL of that file:
   `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/ta_snapshots.json`

## Run locally

```bash
cd pipeline
npm install
SUPABASE_URL=... SUPABASE_ANON_KEY=... TA_OUT=ta_snapshots.json npm start
```

## Env

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `SUPABASE_URL` | yes | — | e.g. `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | yes | — | publishable anon key (ta_universe is public-read) |
| `TA_OUT` | no | `public/data/ta_snapshots.json` | output path; set `ta_snapshots.json` for a shared-data repo |
