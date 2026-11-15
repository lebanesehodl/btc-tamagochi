# Web MVP architecture

One Node.js application serves the client, snapshot/action HTTP APIs, SSE updates, and a single-active block worker. PostgreSQL is authoritative.

## Chain ingestion

Blockstream Esplora is the initial replaceable provider. The server polls the tip hash, retrieves metadata by hash, validates schemas/bounds/heights/parent continuity, and processes at most 24 replacement/new blocks per reconciliation. Block timestamps are informational only; children may have earlier timestamps than parents.

The first observed tip is persisted as an inactive, uncredited journal anchor. It initializes `(height, hash)` without pretending that meals since genesis were delivered. Later connected blocks receive meals from an immutable, versioned pantry. `generic-v1` maps only by height, not clock time; changing a future menu requires an explicit activation-height/version policy.

The chain cursor stores `(height, hash)` while journal rows preserve individual effects. Reconciliation retains a contiguous parent-linked chain suffix, including that anchor. A transition disconnects displaced block effects and connects replacement/missing blocks in chain order. Uniqueness on block hash, active/inactive restoration, height/parent checks, and a database worker fencing token protect exactly-once progression. A 30-second lease is renewed during work; a stale owner cannot commit after handover.

Provider data is labeled provider-reported. HTTPS and structural checks do not independently prove consensus validity. If the source goes down, supplies malformed data, changes during reconciliation, reports a lower height, or lacks a safe common ancestor, no partial effects are applied. Missing baselines and source-behind states pause block progression; community play remains available. No elapsed-time hunger or death exists.

## World and actions

Pet progression, block effects, community actions, den state, and a monotonically increasing world revision commit transactionally with changelog rows. Block effects and community actions are separate, so reorgs do not undo decoration or play. Growth is capped at the 12-block evolution milestone.

Actions use required idempotency keys and transactional slot/version checks. Commit order obtains the world lock consistently to avoid moderator/action lock inversion. Decorations accept catalog IDs only. A visitor can replace their own current contribution; another visitor cannot overwrite it. Moderators can reverse only the action that still owns its slot, so a stale reversal cannot delete newer work.

Anonymous sessions store SHA-256 hashes of 32-byte opaque tokens. Cookies are HttpOnly, SameSite=Lax, and Secure in production. Mutating routes require same-origin/cross-site checks and exact JSON content types. Moderation uses a separate server-only bearer secret and timing-safe comparison. In-memory action budgets are deliberately documented as basic abuse controls rather than durable identity.

## Browser synchronization and publishing

Browsers load a snapshot with a world revision, then consume committed changes over SSE. Each event stores a snapshot payload in `world_events`; the latest 1000 revisions are retained. Clients resume using `after`/native `Last-Event-ID`. The server sends a `reset` snapshot when the requested revision bridges missing history. A subscription queues changes while historical events are read and deduplicates by delivered revision, avoiding the read/subscribe race. Publishing happens only after commit. Comments act as keepalives, and Fastify force-closes live sockets during shutdown so redeployment does not hang on SSE.

## Rendering and hosting

Render runs one public Node service binding `0.0.0.0` and `process.env.PORT`, with managed PostgreSQL. The service serves the production client and API from one origin, avoiding third-party cookies and client-side provider credentials. One instance plus database fencing reduces duplicated workers; deployments still require fencing when instances overlap. `render.yaml` selects the free tier but does not create resources.

Render free services sleep after inactivity and free PostgreSQL expires after 30 days. Sleep pauses observation temporarily; restart reconciles actual provider blocks in bounded batches rather than fabricating elapsed-time meals. These limits make free hosting a playtest, not permanent community hosting. Paid changes require separate OP approval.

A future BWATCH client can consume a versioned read-only snapshot containing pet appearance, den theme, world revision, last processed height/hash, provider/source, observation time, and sync status. No watch credentials or writes are part of this MVP.

## Acceptance evidence and remaining boundaries

Review and tests must distinguish provider API checks from consensus verification and implementation tests. Historical response fixtures include blocks 975859/975858, whose timestamps move backward by 159 seconds while parent linkage remains valid. Focused tests cover source/replay behavior; world tests cover exactly-once effects, fencing, restart-equivalent idempotent retry, reorg separation, simultaneous edits, moderation, and retained-history gaps. Playwright verifies production desktop/mobile rendering, two visitors, and an actual dropped-socket SSE reconnect. UI claims require inspected screenshots; deployment claims require the exact live public URL.

Future seasonal food such as OP’s Bitcoin Pizza Day pizza must preserve old pantry behavior. Any later BWATCH hardware behavior is **needs wrist test** and remains outside this repository’s implementation.
