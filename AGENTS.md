# BTC Tamagochi agent rules

## Product constraints
- One global communal honey badger and den. Web first.
- Generic food/art only until a merchant explicitly approves branding. Never imply an unconfirmed partnership.
- No wallets, keys, seed phrases, payments, paid feeding, or gameplay advantage.
- No permanent death or harm from outages, inactivity, or long block intervals.
- No Nostr dependency, merchant outreach, or automatic merchant posts in this MVP.
- Do not modify any BWATCH repository or firmware.

## Git
- Work only on a feature branch; never commit directly to main.
- OP alone merges. Leave PRs unmerged.
- Keep commits scoped and include A as co-author where required by the operating instructions.

## Path ownership for feat/web-mvp
- A: project setup, deployment, CI, database/world/API/realtime implementation, client UI, docs outside `src/server/bitcoin`.
- Bitcoin: `src/server/bitcoin/**`, its focused tests/fixtures (`tests/bitcoin*.test.ts`, `tests/fixtures/blocks/**`), and `src/shared/bitcoin.ts`.
- Do not edit another owner's files without agreement in the Buzz thread.

## Engineering invariants
- Server state is authoritative. One active worker advances the chain.
- Database uniqueness enforces exactly-once block effects and action idempotency, not only an in-memory lock.
- Chain order follows heights and parent hashes, never timestamps. Timestamps may decrease.
- Keep block-driven effects separate from community actions. A reorg never removes community contributions.
- State, changelog entries, and world revisions commit atomically. Publish realtime changes only after commit.
- Bound catch-up and response sizes. Invalid responses/outages never change progression.
- SSE clients detect revision gaps and recover from a fresh snapshot.
- Anonymous play uses server-issued secure sessions and bounded actions. Protect writes against CSRF and abuse.
- Read-only snapshot includes source and observation/sync metadata. Public block data remains provider-reported, not consensus-verified.

## Verification
- Use real PostgreSQL for world/transaction integration tests.
- Test duplicate blocks/actions, stale worker handover, catch-up, reorg, backward timestamps, restart around commit, invalid/outage behavior, SSE gaps, simultaneous edits, rate limits, and moderator undo.
- Exercise the actual browser flow on desktop and mobile and inspect screenshots.
- Never claim public deployment without opening the live URL. Render free service/database limitations must be disclosed.
