# BTC Tamagochi

A communal honey badger fed by new Bitcoin blocks. This repository contains the web MVP under development on `feat/web-mvp`.

## Scope

One shared badger and den, block-driven meals/growth, anonymous basic play, curated decoration, and realtime updates. No wallet, payments, merchant endorsement, Nostr dependency, or BWATCH changes are part of this prototype.

## Development

Requirements: Node.js 24 and PostgreSQL 16.

```sh
npm ci
docker compose up -d postgres
cp .env.example .env
npm run dev
```

Use `npm run check` for type checking, tests, and a production build. Detailed setup, API, trust, and recovery documentation will be completed alongside the implementation; do not infer working behavior from this scaffold alone.

## Hosting

The intended target is a public Render Node web service with managed PostgreSQL. The GitHub repository is the source of truth; GitHub Pages alone cannot run the server or persistent world. No Render resources are provisioned by this repository. Free Render instances have sleep, usage, and 30-day database limitations documented at https://render.com/docs/free.
