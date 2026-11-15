# BTC Tamagochi / Ratel

A communal pixel honey badger fed by new Bitcoin blocks. One shared den, anonymous play, curated decorations, and live updates. No wallet, payment, account, merchant endorsement, Nostr dependency, or BWATCH change is required.

The public UI is **Ratel**, and the communal honey badger is **Satoshi**. This repository is the web MVP; it is not itself a deployed URL. The established copy does not imply that the pet represents or is endorsed by Bitcoin’s creator. Name/domain/trademark review remains open before a permanent branded launch.

The page is character-led: Satoshi and the shared den take priority over block telemetry. Warm paper, mint, peach, and lilac frame the 8-bit character; generic room details and curated decorations make the den a shared place. Latest-meal food remains visible, while block height/hash, provider observation, and trust details are available through **How meals arrive**. The compact status, pantry, and decoration controls preserve the existing shared-world behavior. Occupied slots carry a visible explanation. Action errors are translated to friendly client-side messages from stable result codes or status codes rather than exposing raw server failures.

## How it works

- The server observes Blockstream Esplora’s mainnet tip. On first start, the observed tip becomes an **uncredited baseline**; historical meals are not awarded.
- Each newly observed block supplies one deterministic meal. `generic-v1` rotates apple, berries, porridge, and honey-toast by block height. The pantry version is stored with each block effect.
- Meals and growth are driven by blocks, not elapsed time. Twelve connected blocks evolve the cub into its rowdy stage. Inactivity and outages do not kill or punish the pet.
- Anyone can play or choose curated den items. No login is needed; an anonymous HttpOnly cookie carries a long opaque session token. This is not proof of unique humanity.
- All visitors share authoritative PostgreSQL state. Committed changes arrive over Server-Sent Events.
- Reorgs undo only displaced block meals. Play and decorations remain intact. Provider-reported data is not independently consensus-verified.
- Optional den stories add a cartoon badger’s seed-oil sickness after fresh CoinGecko BTC/USD falls strictly beyond −5%, steak and deuterium-depleted water when it rises strictly beyond +5%, and occasional hash-selected glare after three confirmations. One story is active globally, each real family has one delivery per UTC date, and free care or ten-minute expiry closes negative stories. Neither ordinary block meals nor inactive/offline pet safety changes. See `docs/stories-v1.md` for exact reconciliation and continuity rules.

## Pixel character assets

OP selected 8-bit as the product art direction. `public/satoshi/` contains the original transparent 48×48 neutral, joyful, and rowdy masters. The client selects **rowdy first**, then **joyful**, then **neutral**, and scales with nearest-neighbor rendering. Food and scene shadows remain separate; no default pizza or merchant branding is included. See `docs/pixel-assets.md` for provenance, state precedence, and verified asset hashes. These claims cover browser assets, not watch hardware.

## Local development

Requirements: Node.js 24, npm, PostgreSQL 16, and Docker for the supplied local database.

```sh
npm ci
docker compose up -d postgres
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`. `npm run dev` builds the client, starts the server with reload, and runs migrations. Set `DISABLE_BLOCK_WORKER=true` in `.env` for deterministic local UI work without polling a public provider.

### Verification

```sh
npm run check
npx playwright install chromium
npm run test:e2e
```

`npm run check` runs TypeScript, all PostgreSQL/unit tests, and the production build. A real worker/reconciler/PostgreSQL regression covers the uncredited baseline, 11/12-block evolution boundary, duplicate polls, reorg rollback/replay, and story trigger/continuity/collision/expiry behavior. `npm run test:e2e` rebuilds, starts an isolated local server with workers disabled, and exercises desktop, mobile, two separate browser visitors, live block feeding/evolution, stories, free care, decoration, stale-decoration conflicts, and actual SSE socket reconnect while preserving paused/degraded/catching-up status. Success screenshots are written to ignored `artifacts/` files; traces on failure go to `test-results/`. CI runs `npm run check` on Node 24 with PostgreSQL 16; browser tests require an explicit Chromium installation.

`npm run check:price` is a separate read-only live CoinGecko freshness check; it is intentionally not a mocked substitute for production readiness. It changes no game state. Passing one response does not establish provider quota headroom.

The PostgreSQL tests reset the dedicated `btc_tamagochi` database. Do not point the tests at production data.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | local PostgreSQL URL | Authoritative shared state; required in deployment |
| `PORT` | `3000` | HTTP port; the service binds `0.0.0.0` |
| `BLOCK_API_BASE_URL` | `https://blockstream.info/api` | Server-controlled HTTPS Esplora endpoint |
| `POLL_INTERVAL_MS` | `60000` | Worker poll interval |
| `DISABLE_BLOCK_WORKER` | `false` | Use `true` for deterministic local work without block polling |
| `DISABLE_STORY_WORKER` | `false` | Use `true` for deterministic tests without price polling/story ticks |
| `STORY_DEMO` | `false` | Enables clearly labelled simulated story controls; never enable for a production live world |
| `NODE_ENV` | — | `production` enables Secure cookies and proxy-aware origin/IP handling |
| `MODERATOR_TOKEN` | unset | Enables the separate bearer-authenticated moderation endpoint; do not expose it to browsers |

No `.env` file is required when the host supplies environment variables directly. Do not commit secrets.

## HTTP contract

- `GET /api/world`: versioned public snapshot; creates or resumes an anonymous session cookie.
- `POST /api/actions`: `{"kind":"play"}`, `{"kind":"decorate","slot":"wall|floor|corner","itemId":"…","expectedVersion":n}`, `{"kind":"story-care","episodeId":"…"}`, or `{"kind":"story-dismiss","episodeId":"…"}` with JSON content type and a unique `Idempotency-Key` header. Same-origin/cross-site checks apply. Completed retries return their original committed result. `story-demo` requires the separate demo environment flag and is rejected otherwise.
- `GET /api/stream?after=REVISION`: committed world SSE events; also accepts `Last-Event-ID`. If revisions are missing, it sends a `reset` snapshot.
- `POST /api/moderation/undo/:actionId`: bearer-protected, `{ "reason": "…" }`; reverses a current decoration only and records an audit reason.
- `GET /healthz`: database health check.

Writes are limited to 20/session, 60/IP, and 300 global actions per rolling minute. These are basic in-memory abuse bounds, not durable identity or a complete anti-Sybil system. Arbitrary uploads and unrestricted room edits are intentionally absent.

## Render hosting

`render.yaml` defines one free Node web service and one free PostgreSQL 16 database. Nothing is provisioned merely by committing it. After review, OP can use **New → Blueprint** in Render, select this repository and the intended reviewed branch/commit, inspect the resources, and apply.

Render must supply the generated `MODERATOR_TOKEN` and managed `DATABASE_URL`; the blueprint wires both. `npm run start` runs migrations, serves the production client/API, and starts the single-active block worker.

**Free-tier limitations:** web services sleep when inactive, causing delayed first loads and paused observation while asleep; blocks are caught up in bounded batches after restart. Free PostgreSQL expires after 30 days. Local files are ephemeral and not world storage. This tier is suitable for a temporary public playtest, not a permanent community world. Upgrade/retention costs need separate OP approval before provisioning paid resources.

## Privacy, moderation, and trust

The server sends public block requests to Esplora and public BTC/USD quote requests to CoinGecko. No addresses, xpubs, keys, credentials, or payment data are collected. Cookies are opaque to browsers via HttpOnly and are secured in production. Block metadata is labeled provider-reported; an independently validating Bitcoin Core-backed source is a future option.

Decoration slots accept only a server catalog. Rate limits and CSRF checks reduce accidental/cross-site abuse. Moderator reversal is restricted to current contributions; older actions cannot silently remove newer visitors’ work.

## Future product ideas — not implemented claims

- Merchant foods may be proposed only with explicit merchant approval. Generic art and copy remain the default; no partnerships are implied. Merchants can be identified on Nostr, but automatic every-block tagging and required Nostr integration are not in this MVP.
- OP requested **pizza for Bitcoin Pizza Day**. A seasonal pizza rotation would use a new pantry version and deterministic height-based activation; `generic-v1` historical behavior must remain immutable. This is a roadmap item, not active in this branch.
- A future BWATCH face can read the versioned public snapshot. No firmware exists here. Any display, timing, power, or refresh claim is **needs wrist test** by OP.

See `docs/architecture.md`, `docs/stories-v1.md`, `src/server/bitcoin/README.md`, and `AGENTS.md` for invariants and ownership.
