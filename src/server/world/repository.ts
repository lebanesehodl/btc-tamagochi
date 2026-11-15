import type { Pool, PoolClient } from "pg";
import {
  EVOLUTION_AFTER_BLOCKS,
  type ActionRequest,
  type ActionResponse,
  type DenItemView,
  type DenSlot,
  type Reaction,
  type WorldSnapshot,
  type WorldTransition,
} from "../../shared/world.ts";
import { validDecoration } from "./catalog.ts";
import { HttpError } from "./errors.ts";
import type { WorkerLease } from "../worker-lease.ts";

const EVENT_RETENTION = 1000;
const SLOT_NAMES = ["wall", "floor", "corner"];

interface SnapshotRow {
  world_revision: string;
  chain_height: string | null;
  chain_hash: string | null;
  hatched_height: string | null;
  joy: number;
  observed_at: Date | null;
  sync_status: WorldSnapshot["chain"]["syncStatus"];
  last_error: string | null;
  source: string;
  active_blocks: string;
  meal: MealDatabaseRow | null;
  den: DenDatabaseRow[];
}

interface MealDatabaseRow {
  block_hash: string;
  height: string;
  block_timestamp: string;
  food_id: string;
  food_name: string;
  pantry_version: string;
  reaction: Reaction;
}

interface DenDatabaseRow {
  slot: DenSlot;
  item_id: string | null;
  version: string;
}

const SNAPSHOT_SQL = `
  SELECT w.*,
    (SELECT count(*) FROM block_journal WHERE active) AS active_blocks,
    (SELECT to_jsonb(m) FROM (
      SELECT block_hash, height, block_timestamp, food_id, food_name, pantry_version, reaction
      FROM block_journal WHERE active ORDER BY height DESC LIMIT 1
    ) m) AS meal,
    COALESCE((SELECT json_agg(to_jsonb(d) ORDER BY d.slot) FROM den_slots d), '[]') AS den
  FROM world_state w WHERE singleton = true
`;

function numberField(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function snapshotFromRow(row: SnapshotRow): WorldSnapshot {
  const activeBlocks = Number(row.active_blocks);
  const growthBlocks = Math.max(0, activeBlocks - 1);
  const hatchedAtHeight = numberField(row.hatched_height);
  const fullness = activeBlocks === 0 ? 0 : Math.min(100, 40 + activeBlocks * 20);
  const joy = row.joy;
  const meal = row.meal;
  return {
    schema: 1,
    revision: Number(row.world_revision),
    pet: {
      stage: growthBlocks >= EVOLUTION_AFTER_BLOCKS ? "rowdy" : "cub",
      mood: joy >= 80 ? "joyful" : fullness >= 60 ? "content" : "hungry",
      joy,
      fullness,
      growthBlocks,
      nextEvolutionAt: hatchedAtHeight === null || growthBlocks >= EVOLUTION_AFTER_BLOCKS
        ? null
        : hatchedAtHeight + EVOLUTION_AFTER_BLOCKS,
      hatchedAtHeight,
      meals: activeBlocks,
      lastMeal: meal === null ? null : {
        blockHash: meal.block_hash,
        height: Number(meal.height),
        timestamp: Number(meal.block_timestamp),
        foodId: meal.food_id,
        foodName: meal.food_name,
        reaction: meal.reaction,
        pantryVersion: meal.pantry_version,
      },
    },
    den: row.den.map((item) => ({
      slot: item.slot,
      itemId: item.item_id,
      version: Number(item.version),
    })),
    chain: {
      height: numberField(row.chain_height),
      hash: row.chain_hash,
      source: row.source,
      observedAt: row.observed_at?.toISOString() ?? null,
      syncStatus: row.sync_status,
      lastError: row.last_error,
      trust: "provider-reported",
    },
  };
}

export interface WorldEvent {
  revision: number;
  snapshot: WorldSnapshot;
}

export class WorldRepository {
  private readonly listeners = new Set<(event: WorldEvent) => void>();

  constructor(readonly pool: Pool, private readonly eventRetention = EVENT_RETENTION) {}

  onWorld(listener: (event: WorldEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async snapshot(client: PoolClient | null = null): Promise<WorldSnapshot> {
    const result = client
      ? await client.query(SNAPSHOT_SQL)
      : await this.pool.query(SNAPSHOT_SQL);
    if (!result.rows[0]) throw new Error("World state is missing; run migrations first");
    return snapshotFromRow(result.rows[0]);
  }

  async knownActiveChain(): Promise<Array<{ id: string; height: number; previousblockhash: string | null; timestamp: number }>> {
    const result = await this.pool.query(
      "SELECT block_hash AS id, height, parent_hash AS previousblockhash, block_timestamp AS timestamp FROM block_journal WHERE active OR block_hash = (SELECT chain_hash FROM world_state) ORDER BY height ASC",
    );
    return result.rows.map((row) => ({
      id: row.id,
      height: Number(row.height),
      previousblockhash: row.previousblockhash,
      timestamp: Number(row.timestamp),
    }));
  }

  async applyTransition(transition: WorldTransition, lease: WorkerLease | null = null): Promise<WorldSnapshot> {
    const client = await this.pool.connect();
    let committed: WorldSnapshot | null = null;
    try {
      await client.query("BEGIN");
      if (lease) {
        const current = await client.query(
          "SELECT 1 FROM worker_leases WHERE name = 'blocks' AND owner = $1 AND fencing_token = $2 AND expires_at > now() FOR UPDATE",
          [lease.owner, lease.fencingToken],
        );
        if (current.rowCount !== 1) throw new HttpError(409, "Block-worker lease is stale");
      }
      const locked = await client.query("SELECT world_revision, chain_height, chain_hash, hatched_height FROM world_state FOR UPDATE");
      const before = locked.rows[0];
      if (!before) throw new Error("World state is missing");
      if (transition.connect.length === 0 && transition.disconnect.length === 0) {
        await client.query("COMMIT");
        return this.snapshot();
      }
      if (transition.connect.length === 1 && before.chain_hash === transition.connect[0]?.block.id && transition.disconnect.length === 0) {
        await client.query("COMMIT");
        return this.snapshot();
      }

      let currentHeight = numberField(before.chain_height);
      let currentHash: string | null = before.chain_hash;
      for (const expectedHash of transition.disconnect) {
        if (currentHash !== expectedHash) throw new HttpError(409, "Disconnect order does not match the active tip");
        const removed = await client.query(
          "UPDATE block_journal SET active = false, observed_at = $2 WHERE block_hash = $1 AND active = true RETURNING parent_hash, height",
          [expectedHash, transition.observedAt],
        );
        if (removed.rowCount !== 1) throw new HttpError(409, "Cannot disconnect an unknown or inactive block");
        if (currentHeight !== Number(removed.rows[0].height)) throw new HttpError(409, "Active-chain height discontinuity");
        currentHash = removed.rows[0].parent_hash;
        currentHeight = currentHeight === null ? null : currentHeight - 1;
      }

      for (const applied of transition.connect) {
        const { block, meal } = applied;
        const active = applied.active !== false;
        if (!Number.isSafeInteger(block.height) || block.height < 0 || !Number.isSafeInteger(block.timestamp)) {
          throw new HttpError(422, "Invalid block metadata bounds");
        }
        if (currentHash !== null) {
          if (currentHeight === null || block.height !== currentHeight + 1 || block.previousblockhash !== currentHash) {
            throw new HttpError(409, "Connected block does not extend the active chain");
          }
        } else {
          if (before.hatched_height !== null) throw new HttpError(409, "Cannot reinitialize an existing world from no chain");
          if (currentHeight !== null || transition.disconnect.length !== 0 || transition.connect.length !== 1) {
            throw new HttpError(409, "A new world must start with exactly one chain block");
          }
          await client.query("UPDATE world_state SET hatched_height = $1", [block.height]);
        }
        const inserted = await client.query(
          `INSERT INTO block_journal
             (block_hash, height, parent_hash, block_timestamp, food_id, food_name, pantry_version, reaction, active, observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT(block_hash) DO NOTHING
           RETURNING block_hash`,
          [block.id, block.height, block.previousblockhash, block.timestamp, meal.foodId, meal.foodName, meal.pantryVersion, meal.reaction, active, transition.observedAt],
        );
        if (inserted.rowCount !== 1) {
          const restored = await client.query(
            `UPDATE block_journal SET active = $10, observed_at = $2
             WHERE block_hash = $1 AND active = false AND height = $3 AND parent_hash IS NOT DISTINCT FROM $4
               AND block_timestamp = $5 AND food_id = $6 AND food_name = $7 AND pantry_version = $8 AND reaction = $9`,
            [transition.observedAt, block.id, block.height, block.previousblockhash, block.timestamp, meal.foodId, meal.foodName, meal.pantryVersion, meal.reaction, active],
          );
          if (restored.rowCount !== 1) throw new HttpError(409, "Block was already processed or conflicts with journal history");
        }
        currentHeight = block.height;
        currentHash = block.id;
      }

      if (currentHash === null) throw new HttpError(409, "Transition exceeds the retained safe baseline");
      const revised = await client.query(
        `UPDATE world_state SET
           world_revision = world_revision + 1,
           chain_height = $1,
           chain_hash = $2,
           observed_at = $3,
           sync_status = $4,
           last_error = NULL
         RETURNING world_revision`,
        [currentHeight, currentHash, transition.observedAt, transition.syncStatus],
      );
      if (!revised.rows[0]) throw new Error("World revision could not advance");
      const snapshot = await this.snapshot(client);
      await this.insertEvent(client, snapshot, Number(before.world_revision) + 1);
      committed = snapshot;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const event = committed as WorldSnapshot | null;
    if (event) this.publish(event);
    return event as WorldSnapshot;
  }

  async markHealthy(observedAt = new Date().toISOString()): Promise<void> {
    await this.setSyncStatus("synced", null, observedAt);
  }

  async markDegraded(message: string, status: "degraded" | "paused" = "degraded"): Promise<void> {
    await this.setSyncStatus(status, message.slice(0, 300), new Date().toISOString());
  }

  private async setSyncStatus(status: WorldSnapshot["chain"]["syncStatus"], lastError: string | null, observedAt: string): Promise<void> {
    const client = await this.pool.connect();
    let change: WorldSnapshot | null = null;
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT world_revision, sync_status, last_error FROM world_state FOR UPDATE");
      const before = locked.rows[0];
      const changed = before.sync_status !== status || before.last_error !== lastError;
      await client.query(
        `UPDATE world_state SET sync_status = $1, last_error = $2, observed_at = $3, world_revision = world_revision + $4::int`,
        [status, lastError, observedAt, changed ? 1 : 0],
      );
      if (changed) {
        change = await this.snapshot(client);
        await this.insertEvent(client, change, Number(before.world_revision) + 1);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (change) this.publish(change);
  }

  async ensureSession(tokenHash: Buffer): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO sessions(token_hash) VALUES ($1) ON CONFLICT(token_hash) DO UPDATE SET last_seen_at = now() RETURNING id`,
      [tokenHash],
    );
    return result.rows[0].id;
  }

  async applyAction(sessionId: string, idempotencyKey: string, action: ActionRequest): Promise<ActionResponse> {
    const client = await this.pool.connect();
    let response: ActionResponse | null = null;
    try {
      await client.query("BEGIN");
      const actionRecord = await client.query(
        `INSERT INTO community_actions(session_id, idempotency_key, action_kind, payload)
         VALUES ($1,$2,$3,$4) ON CONFLICT(session_id, idempotency_key) DO NOTHING RETURNING id`,
        [sessionId, idempotencyKey, action.kind, JSON.stringify(action)],
      );
      if (!actionRecord.rows[0]) {
        const original = await this.pool.query(
          "SELECT id, action_kind, payload, result FROM community_actions WHERE session_id = $1 AND idempotency_key = $2",
          [sessionId, idempotencyKey],
        );
        const existing = original.rows[0];
        if (!existing || existing.action_kind !== action.kind || JSON.stringify(existing.payload) !== JSON.stringify(action)) {
          throw new HttpError(409, "Idempotency key was already used for a different action");
        }
        if (!existing.result) throw new HttpError(409, "Action is already in progress");
        await client.query("COMMIT");
        return { actionId: existing.id, duplicate: true, snapshot: existing.result };
      }
      const actionId = actionRecord.rows[0].id;
      const world = await client.query("SELECT world_revision FROM world_state FOR UPDATE");
      const revision = Number(world.rows[0].world_revision);
      if (action.kind === "play") {
        await client.query("UPDATE world_state SET joy = LEAST(100, joy + 10)");
      } else {
        if (!validDecoration(action.slot, action.itemId) || !Number.isSafeInteger(action.expectedVersion) || action.expectedVersion < 0) {
          throw new HttpError(422, "Unknown decoration or invalid slot version", "invalid_decoration");
        }
        const current = await client.query(
          "SELECT s.version, s.action_id, c.session_id FROM den_slots s LEFT JOIN community_actions c ON c.id = s.action_id WHERE s.slot = $1 FOR UPDATE OF s",
          [action.slot],
        );
        const slot = current.rows[0];
        if (!slot) throw new HttpError(422, "Unknown den slot");
        if (Number(slot.version) !== action.expectedVersion) throw new HttpError(409, "The den changed; refresh and try again", "den_changed");
        if (slot.action_id && slot.session_id !== sessionId) throw new HttpError(409, "Another visitor contributed this item; choose an open slot", "slot_taken");
        await client.query(
          "UPDATE den_slots SET item_id = $1, version = version + 1, action_id = $2 WHERE slot = $3",
          [action.itemId, actionId, action.slot],
        );
      }
      const updated = await client.query("UPDATE world_state SET world_revision = world_revision + 1 RETURNING world_revision");
      if (Number(updated.rows[0].world_revision) !== revision + 1) throw new Error("World revision race");
      const snapshot = await this.snapshot(client);
      await client.query("UPDATE community_actions SET result = $1 WHERE id = $2", [JSON.stringify(snapshot), actionId]);
      await this.insertEvent(client, snapshot, revision + 1);
      response = { actionId, duplicate: false, snapshot };
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (!response) throw new Error("Action did not produce a response");
    this.publish(response.snapshot);
    return response;
  }

  async undoDecoration(actionId: string, reason: string): Promise<WorldSnapshot> {
    if (!reason.trim() || reason.length > 200) throw new HttpError(422, "A moderation reason of 1–200 characters is required");
    const client = await this.pool.connect();
    let snapshot: WorldSnapshot | null = null;
    try {
      await client.query("BEGIN");
      await client.query("SELECT world_revision FROM world_state FOR UPDATE");
      const action = await client.query("SELECT * FROM community_actions WHERE id = $1 FOR UPDATE", [actionId]);
      if (!action.rows[0] || action.rows[0].action_kind !== "decorate") throw new HttpError(404, "Decorative action not found");
      if (action.rows[0].reversed) throw new HttpError(409, "Action was already reversed");
      const slotName = action.rows[0].payload.slot as string;
      const slot = await client.query("SELECT version FROM den_slots WHERE slot = $1 AND action_id = $2 FOR UPDATE", [slotName, actionId]);
      if (!slot.rows[0]) throw new HttpError(409, "A newer decoration has replaced this action");
      await client.query("UPDATE den_slots SET item_id = NULL, version = version + 1 WHERE slot = $1", [slotName]);
      await client.query("UPDATE community_actions SET reversed = true WHERE id = $1", [actionId]);
      await client.query("INSERT INTO moderation_audit(action_id, reason) VALUES ($1,$2)", [actionId, reason.trim()]);
      await client.query("UPDATE world_state SET world_revision = world_revision + 1");
      snapshot = await this.snapshot(client);
      await this.insertEvent(client, snapshot, snapshot.revision);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const event = snapshot as WorldSnapshot | null;
    if (!event) throw new Error("Moderation did not produce a snapshot");
    this.publish(event);
    return event;
  }

  async chainCursor(): Promise<{ height: number; hash: string } | null> {
    const result = await this.pool.query("SELECT chain_height, chain_hash FROM world_state WHERE singleton = true");
    if (result.rows[0]?.chain_hash === null || result.rows[0]?.chain_hash === undefined) return null;
    return { height: Number(result.rows[0].chain_height), hash: result.rows[0].chain_hash };
  }

  async eventsAfter(after: number): Promise<{ events: WorldEvent[]; reset?: WorldSnapshot }> {
    if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, "Invalid world revision");
    const world = await this.pool.query("SELECT world_revision FROM world_state");
    const latest = Number(world.rows[0].world_revision);
    if (after > latest) return { events: [], reset: await this.snapshot() };
    const result = await this.pool.query(
      "SELECT revision, payload FROM world_events WHERE revision > $1 ORDER BY revision ASC LIMIT $2",
      [after, this.eventRetention],
    );
    if (result.rows[0] && Number(result.rows[0].revision) !== after + 1) {
      return { events: [], reset: await this.snapshot() };
    }
    return { events: result.rows.map((row) => ({ revision: Number(row.revision), snapshot: row.payload })) };
  }

  private publish(snapshot: WorldSnapshot): void {
    for (const listener of this.listeners) listener({ revision: snapshot.revision, snapshot });
  }

  private async insertEvent(client: PoolClient, snapshot: WorldSnapshot, expectedRevision: number): Promise<void> {
    if (snapshot.revision !== expectedRevision) throw new Error("Unexpected world revision");
    await client.query("INSERT INTO world_events(revision, payload) VALUES ($1, $2)", [snapshot.revision, JSON.stringify(snapshot)]);
    await client.query("DELETE FROM world_events WHERE revision <= $1", [Math.max(0, snapshot.revision - this.eventRetention)]);
  }
}

export function assertDenSlots(snapshot: WorldSnapshot): void {
  if (snapshot.den.map((item: DenItemView) => item.slot).sort().join() !== [...SLOT_NAMES].sort().join()) {
    throw new Error("Database den slots do not match the application contract");
  }
}
