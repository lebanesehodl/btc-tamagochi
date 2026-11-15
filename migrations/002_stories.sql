ALTER TABLE community_actions DROP CONSTRAINT community_actions_action_kind_check;
ALTER TABLE community_actions ADD CONSTRAINT community_actions_action_kind_check
  CHECK (action_kind IN ('play', 'decorate', 'story-care', 'story-dismiss', 'story-demo'));

CREATE TABLE story_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  rule_version text NOT NULL DEFAULT 'story-v1',
  activation_height bigint CHECK (activation_height >= 0),
  live_boundary_height bigint CHECK (live_boundary_height >= 0),
  price_zone text NOT NULL DEFAULT 'baseline-required'
    CHECK (price_zone IN ('baseline-required', 'neutral', 'down', 'up')),
  price_change text,
  price_usd text,
  price_source_updated_at timestamptz,
  price_received_at timestamptz
);

INSERT INTO story_state(singleton, activation_height, live_boundary_height)
SELECT true, chain_height + 1, chain_height FROM world_state WHERE singleton = true;

CREATE TABLE story_episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true CHECK (singleton),
  trigger_family text NOT NULL CHECK (trigger_family IN ('price-down', 'price-up', 'hash-mischief')),
  demo boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  cause jsonb NOT NULL,
  opened_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  close_reason text CHECK (close_reason IN ('expired', 'care', 'dismissed', 'reorg', 'demo-replaced')),
  delivery_utc_date date
);
CREATE UNIQUE INDEX story_one_active ON story_episodes(singleton) WHERE status = 'active';
CREATE UNIQUE INDEX story_family_daily ON story_episodes(singleton, trigger_family, delivery_utc_date)
  WHERE NOT demo;
CREATE INDEX story_hash_cause ON story_episodes((cause ->> 'blockHash')) WHERE status = 'active';

CREATE TABLE story_hash_candidates (
  story_version text NOT NULL,
  block_hash text NOT NULL,
  height bigint NOT NULL CHECK (height >= 0),
  status text NOT NULL CHECK (status IN ('pending', 'consumed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  PRIMARY KEY(story_version, block_hash)
);
CREATE INDEX story_hash_pending_height ON story_hash_candidates(height) WHERE status = 'pending';
