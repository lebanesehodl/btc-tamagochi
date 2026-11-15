# Bitcoin block-source and replay boundary

Owned by Bitcoin for the web MVP. The public exports are in `index.ts`; shared types are in `../../shared/bitcoin.ts`.

## Trust and privacy

`EsploraBlockSource` defaults to `https://blockstream.info/api`. It uses the runtime's normal HTTPS certificate validation, disables redirects and caching, omits credentials, caps streamed responses at 16 KiB, and applies a 10-second deadline to the entire response (including a stalled body). The adapter performs no retries; the worker owns bounded backoff. Any alternate HTTPS endpoint is trusted **server configuration**, never visitor input.

Only public block hashes/heights leave the backend. Blockstream sees the backend's IP and request timing; the application has no address, xpub, seed, private-key, wallet, or payment path. Error messages exclude response bodies and upstream exception text. No TLS bypass is present.

Hash format, numeric bounds, response identity, parent linkage, and continuity are checked. These are structural defenses, **not** proof-of-work, header-hash, difficulty, chainwork, transaction, or consensus verification. A coherent dishonest provider can still mislead the game. Display provider-reported status. An independently validating Bitcoin Core-backed source is a future alternative behind the same interface.

## Worker integration

```ts
import { EsploraBlockSource, reconcileChain, mealForBlock } from "./bitcoin/index.js";

const source = new EsploraBlockSource();
// Read the saved contiguous active-chain suffix and its cursor under the world's protocol.
const transition = await reconcileChain(source, retainedBlocksAscending, {
  maxBatchBlocks: 24,
  maxReorgDepth: 144,
});
const meals = transition.connect.map((block) => mealForBlock(block));
// In ONE database transaction: fence the worker, compare the original cursor,
// undo disconnected block effects, apply connected effects/meals, persist the
// cursor/world revision/change log. Publish only after commit.
```

The example's `retainedBlocksAscending` is provided by the world layer, not a module global. On first initialization, persist an observed tip as the baseline **without** back-awarding meals since genesis. Reconciliation requires a nonempty retained suffix. The oldest retained block is an anchor; if it is displaced, recovery needs older history or an explicitly re-established baseline. Never silently drop that anchor or award inferred meals.

- `disconnect` is ordered highest height first; `connect` is lowest first. Inputs are copied and never mutated.
- A duplicate current tip yields empty lists. A formerly disconnected hash can legitimately be reconnected; do not globally ignore it forever. Persist one block-effect record per hash with reversible active/inactive state (or equivalent transactional semantics).
- Offline catch-up fetches at most `maxBatchBlocks` new/replacement blocks per call, rather than walking back from a distant tip. Keep reconciling in bounded worker iterations. A reorg can produce a partial replacement branch; subsequent calls finish catch-up.
- The default maximum reorg depth is a resource/recovery policy, **not finality**. At most `maxReorgDepth + maxBatchBlocks + 6` source calls are needed per reconciliation (worst-case budget); the worker should also bound total time/backoff across iterations. Untrusted body size and individual response time are capped separately.
- Parent hashes and heights define ordering. Block timestamps are informational and may decrease; do not sort by them or enforce adjacent monotonicity.
- Before returning changes, the planner rechecks the selected end-height mapping and source tip. A moving/inconsistent view yields no transition. This cannot prevent a reorg after the check; the next reconciliation handles it.
- Food/evolution effects are separate from visitor play/decorations. Never rewind the whole world snapshot to undo a block.

### Error handling

`BitcoinDataError.code` distinguishes `invalid-input`, `invalid-response`, `http-error`, `timeout`, `transport-error`, `missing-baseline`, `source-behind`, `source-changed`, and `baseline-unavailable`. HTTP failures include a numeric `status` (including 429); no response body is retained. Do not let failures generate meals or punish the pet. Persist/serve the last valid state and expose sync status.

`source-changed` is an expected retryable snapshot race. `baseline-unavailable` requires retaining/fetching an older contiguous baseline, or explicit recovery. `source-behind` pauses if the source reports a height below the saved cursor: a lagging explorer must not erase progress. This conservative rule also pauses an unusual legitimate shorter, higher-work fork; it does not claim such forks are impossible or invalid. Resolution needs source investigation/validation and explicit recovery, not an automatic cursor reset.

## Generic food rotation

`GENERIC_PANTRY` is deeply frozen. `generic-v1` cycles by `height % 4`: apple, berries, porridge, honey-toast. All meals have equal progression effect in the world layer. No timestamp, clock, random generator, visitor action, payment, or merchant influences selection. Illustrations/food are fictional, not animal-care advice.

Persist `BlockMeal.pantryVersion` with the block effect. Do not change the IDs/order of a published menu version. This release has only `generic-v1`; adding a later version requires keeping prior definitions and defining a deterministic activation-height schedule so replay/reconnect select the historical version. Unknown versions fail, not silently fall back. A replacement at the same height receives the same food, but its effect identity is the new block hash.

## Verification and sources

Run `npx vitest run tests/bitcoin*.test.ts`. Tests cover hostile HTTP/JSON, byte limits, deadlines before headers/during the body, duplicate delivery, batched catch-up, missing/disconnected metadata, same-height forks, disconnect/reconnect of a prior hash, source races, bounded history, outages, and immutable food replay.

`tests/fixtures/blocks/backward-timestamps.json` preserves provider metadata for 975858/975859: the child precedes its parent's timestamp by 159 seconds but must produce one new meal, then none on duplicate observation. Fixture source URLs and trust limits are in the neighboring README. Other chains are synthetic and do not claim consensus validity.

Mutation check: in an isolated verification worktree, disable the `cursor.previousblockhash !== ancestor.id` guard in `reconcile.ts`; the disconnected-metadata test must fail. Restore the guard and rerun all focused tests. Do not mutate the shared integration worktree while another agent is testing it.

Primary contracts:
- [Esplora block endpoints and fields](https://github.com/Blockstream/esplora/blob/master/API.md#blocks).
- [Bitcoin Core chain-state RPC: most-work fully-validated chain](https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/getblockchaininfo/).
- [Bitcoin Core reorg and notification-loss caveats](https://github.com/bitcoin/bitcoin/blob/master/doc/zmq.md#remarks).

The focused suite verifies this boundary, not database exactly-once semantics, worker fencing, SSE recovery, browser behavior, or public deployment. Those are world/application acceptance checks owned by A.
