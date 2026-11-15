CREATE TABLE world_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  world_revision bigint NOT NULL DEFAULT 0 CHECK (world_revision >= 0),
  chain_height bigint CHECK (chain_height >= 0),
  chain_hash text,
  hatched_height bigint CHECK (hatched_height >= 0),
  joy integer NOT NULL DEFAULT 40 CHECK (joy BETWEEN 0 AND 100),
  observed_at timestamptz,
  sync_status text NOT NULL DEFAULT 'starting',
  last_error text,
  source text NOT NULL DEFAULT 'https://blockstream.info/api'
);

INSERT INTO world_state(singleton) VALUES (true);

CREATE TABLE block_journal (
  block_hash text PRIMARY KEY,
  height bigint NOT NULL CHECK (height >= 0),
  parent_hash text,
  block_timestamp bigint NOT NULL,
  food_id text NOT NULL,
  food_name text NOT NULL,
  pantry_version text NOT NULL,
  reaction text NOT NULL CHECK (reaction IN ('happy', 'curious', 'sleepy')),
  active boolean NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX block_journal_active_height ON block_journal(height) WHERE active;

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE community_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id),
  idempotency_key text,
  action_kind text NOT NULL CHECK (action_kind IN ('play', 'decorate')),
  payload jsonb NOT NULL,
  result jsonb,
  reversed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, idempotency_key)
);
ALTER TABLE community_actions ALTER COLUMN idempotency_key SET NOT NULL;

CREATE TABLE den_slots (
  slot text PRIMARY KEY CHECK (slot IN ('wall', 'floor', 'corner')),
  item_id text,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  action_id uuid REFERENCES community_actions(id)
);
INSERT INTO den_slots(slot) VALUES ('wall'), ('floor'), ('corner');

CREATE TABLE world_events (
  revision bigint PRIMARY KEY CHECK (revision > 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX world_events_created ON world_events(created_at);

CREATE TABLE moderation_audit (
  id bigserial PRIMARY KEY,
  action_id uuid NOT NULL REFERENCES community_actions(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE worker_leases (
  name text PRIMARY KEY,
  owner uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  expires_at timestamptz NOT NULL
);
