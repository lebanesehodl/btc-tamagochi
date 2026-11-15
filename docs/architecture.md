# Web MVP architecture

One Node.js application serves the client, snapshot/action HTTP APIs, SSE updates, and a single-active block worker. PostgreSQL is authoritative.

## Chain ingestion

Blockstream Esplora is the initial replaceable provider. The server polls the tip hash, retrieves metadata by hash, validates schemas/bounds/heights/parent continuity, and processes bounded batches. Block timestamps are informational only; children may have earlier timestamps than parents.

The chain cursor stores `(height, hash)`. A transition disconnects displaced block effects and connects replacement/missing blocks in chain order. A database uniqueness constraint prevents duplicate block effects. If reconciliation cannot reach a retained baseline, progression pauses rather than guessing.

Provider data is labeled provider-reported. HTTPS and structural checks do not independently prove consensus validity.

## World and actions

Pet progression, block effects, community actions, den state, and a monotonically increasing world revision commit transactionally with changelog rows. Block effects and community actions are separate, so reorgs do not undo decoration or play.

Actions use idempotency keys and transactional slot/version checks. Anonymous sessions are not proof of unique people. Curated decorations, bounded slots, rate limits, CSRF defenses, moderator permissions, and auditable undo limit damage.

## Browser synchronization

Browsers load a snapshot with a world revision, then consume committed changes over SSE. They resume after the observed revision and fetch a fresh snapshot on any retained-history gap. Publishing happens after database commit.

## Rendering/hosting

Render runs one public Node service binding `0.0.0.0` and `process.env.PORT`, with managed PostgreSQL. The service serves the production client and API from one origin. Render free services sleep after inactivity and free PostgreSQL expires after 30 days; neither should be described as permanent production hosting.

The future BWATCH client can consume a versioned read-only snapshot containing pet appearance, den theme, world revision, last processed height/hash, provider/source, observation time, and sync status. No watch credentials or writes are part of this MVP.

## Acceptance evidence

Review and tests must distinguish provider API checks from consensus verification and implementation tests. Historical response fixtures include blocks 975859/975858, whose timestamps move backward while parent linkage remains valid. UI claims require real browser interaction and inspected screenshots; deployment claims require the exact live public URL.
