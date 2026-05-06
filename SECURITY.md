# Security Policy

## Reporting

If you discover a security issue, please contact the maintainer via GitHub profile rather than opening a public issue.

## Scope

This repository contains:

- Public market data fetched from third-party APIs (Binance, CoinGecko, DefiLlama, Yahoo Finance, alternative.me, Coinalyze)
- GitHub Actions workflows that compute and commit JSON snapshots
- No user data, no private keys, no wallet addresses

## Secret hygiene

- All secrets stored in GitHub Actions Secrets, never in source.
- `.env` files are gitignored. `.env.example` is the canonical local-dev template.
- gitleaks pre-commit hook configured locally to block accidental commits of secrets.
- Workflows pinned to commit SHAs, not floating tags.

## Rate limits

This repo intentionally throttles to public free tiers. Do not raise cron frequency without verifying the upstream provider's terms of service.
