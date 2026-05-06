# portflow-data

Public data layer for **Portflow** — a $0/mo crypto portfolio + market intelligence PWA.

## What this repo does

GitHub Actions workflows fetch public market data on a schedule and commit JSON snapshots to `data/`. The Portflow frontend (Cloudflare Pages) reads these JSON files via raw.githubusercontent.com / jsDelivr CDN.

## Data files

| File                     | Refresh cadence | Source                                                                             |
| ------------------------ | --------------- | ---------------------------------------------------------------------------------- |
| `data/prices.json`       | 15 min          | CoinGecko                                                                          |
| `data/ta_snapshots.json` | 15 min          | Binance public klines + pandas-ta                                                  |
| `data/categories.json`   | 1 hour          | CoinGecko categories                                                               |
| `data/market.json`       | 15 min          | CoinGecko global, alternative.me F&G, Coinalyze, Binance, DefiLlama, Yahoo Finance |

All workflows in `.github/workflows/`. Scripts in `scripts/`.

## Architecture
GitHub Actions cron → Python script → fetch APIs → write data/*.json → git commit → CDN → Portflow frontend

No server. No VPS. No database. Static JSON over HTTPS.

## Security

See [SECURITY.md](./SECURITY.md). All secrets live in GitHub Actions Secrets.

## License

MIT — see [LICENSE](./LICENSE).