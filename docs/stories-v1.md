# Den stories v1

Status: story-only implementation on `feat/story-v1`. No payments, paid feeding, wallets, keys, keepsakes, merchant endorsement, firmware, or BWATCH changes. OP has not merged or publicly deployed this branch.

## Approved triggers

- **Price down:** fresh CoinGecko BTC/USD `usd_24h_change`, strictly below `-5` on the original decimal token, opens **FIAT SNACK TRUCK**. Satoshi gets cartoon seed-oil sickness; free care closes the episode. Ordinary meals and growth are unchanged.
- **Price up:** the same source/window, strictly above `+5`, opens **STEAK TRUCK** with deuterium-depleted water. This is a temporary celebration; dismissal closes it. No care step is required.
- **Hash mischief:** a selected, mature canonical block opens **A DELIVERY** and temporary **GLARED** fiction. Free care closes it. The selector is `SHA256(UTF8("btc-tamagochi/story-v1") || 0x00 || displayedHashBytes)[0] < 8`; the displayed 64-character hash is decoded without reversing bytes.

The exact quote—not a value rounded to one decimal—decides the threshold. The UI explains when a qualifying value rounds to the boundary. Price is provider-reported and is not independently consensus-verified. Hash selection is domain-separated taste choice, not security randomness, a prize, or gameplay power.

Exactly one episode is globally active. Price wins if price and hash become eligible in the same tick. A suppressed candidate is consumed; there is no queue, preemption, catch-up replay, or permanent death/harm. Each real trigger family has at most one delivery per UTC date. Repeating polls, midnight, expiry, and free care do not rearm the current extreme zone. `down` and `up` latch independently.

## Recovery and reconciliation

The migration stores immutable `story-v1` activation and a live-chain boundary. Fresh worlds publish them in `story` after the uncredited hatch baseline is established. Bootstrap/catch-up transitions and multi-block recovery consume candidates rather than telling old stories. Mature candidates are consumed without opening an episode while the chain is degraded, and every return to `synced`—including a no-tip-change recovery—sets the boundary at that reconciled tip and consumes its pending candidates. A normal single live tip extension can arm a new candidate; it matures only with itself plus two canonical descendants.

Disconnecting a pending causal block removes it. Disconnecting the cause of an active glare episode closes only that episode with `reorg`; unrelated play, meals, decorations, and price stories are preserved. Consumed candidates and completed/cared/closed episodes do not reopen on canonical replay. Existing block-meal reorg rollback is unchanged.

Missing/stale/failed price data creates no episode and requires a new baseline. Every newly constructed worker suppresses a candidate on its first fresh quote, even if a prior process left persisted continuity. The first fresh quote after that process start, an invalid poll, a source conflict, or an observation gap establishes continuity without firing. A later entry from a genuinely different zone can fire.

## Timing and actions

Episodes auto-close after 600 seconds in the evaluator. The client hides an expired card and announces the approved family-specific closing line. Negative episodes also accept `story-care`; celebrations accept `story-dismiss`. Both use the existing server-authoritative, session-scoped, idempotent `/api/actions` path and the same-origin/rate limits. Demo actions are separate and are rejected unless `STORY_DEMO=true`.

The story worker ticks every 60 seconds and fetches price at most every five minutes. Network fetching completes before the database transaction. A transaction locks the world and story state, consumes inputs atomically, updates snapshots/events/revisions together, and commits before listeners publish. Demo replacement is explicit and is never a production preemption rule.

`/api/world` includes `story.ruleVersion`, `story.activationHeight`, current episode, public cause, and provider observation status. Demo episodes use `cause: {"kind":"demo"}` and the UI displays **DEMO — SIMULATED, NOT LIVE**. They contain no invented price percentage, quote timestamp, block height, or block hash.

## Price-provider limits and production gate

Fixed endpoint:

```text
https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true
```

The client requires HTTP 200, a maximum 16 KiB response, strict JSON with no duplicate keys, positive bounded USD price, a finite original-decimal change strictly greater than −100, and integer Unix-seconds provenance. All three numeric tokens must belong to the actual `bitcoin` object; unrelated assets and duplicate null/value tricks cannot supply them. Limits are source age ≤300 seconds, future skew ≤30 seconds, receipt gap ≤600 seconds, five-second request deadline, no redirects, ordinary certificate/hostname verification, and no silent provider substitution.

A successful unit fixture is not evidence of production health. Before merge or deployment, reviewers must run the read-only command at the current head and inspect its result:

```sh
npm ci
npm run check:price
```

It changes no world state. Passing confirms one current response meets freshness/shape requirements only; it does not prove anonymous CoinGecko quota headroom at sustained five-minute polling. Quota/429 behavior and suitable deployment headroom still need observation. A keyless anonymous provider that continuously reports stale data cannot arm production price stories; this must be surfaced rather than bypassed.

## Copy

The implementation uses the approved v4.1 primary lines for fiat snacks, seed oil, steak, fancy water, glare, family-specific free care/expiry, and the celebration. **Dr. Lumen** is the fictional original character. Dr. Jack Kruse draft lines are not shipped and no endorsement or participation is implied.

The footer states: “Badger is a cartoon. Nothing here is health advice or financial advice.” Numbers, UTC timestamps, sources, and block hashes are factual UI data. Fiction is not a nutrition, blue-light, medical, or financial claim.

## Verification scope

`npm run check` covers TypeScript, exact decimal boundaries, hostile quote validation, PostgreSQL persistence, per-family caps, busy/cooldown behavior, concurrent evaluation, hash maturity/collisions/reorgs, degraded/outage/no-op-recovery suppression, price-worker restart baselining, shared-repository live SSE composition, expiry, idempotent care, and the production build. `npm run test:e2e` exercises real browser rendering, desktop/mobile screenshots, actual SSE delivery to a second visitor, family-specific free care and expiry announcements, dismissal, and demo-disabled/enabled behavior.

Host tests do **not** prove live provider freshness/quota, a public URL, or watch hardware behavior. There are no display, power, haptics, sensor, or real-timing claims requiring a wrist test because this slice is web-only.
