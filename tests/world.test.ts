import crypto from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActionRequest, AppliedBlock, WorldTransition } from "../src/shared/world.ts";
import { migrate } from "../src/server/migrate.ts";
import { WorldRepository } from "../src/server/world/repository.ts";
import { acquireWorkerLease } from "../src/server/worker-lease.ts";

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/btc_tamagochi", max: 20 });
const repository = new WorldRepository(pool);
const hash = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");
const session = (name: string): Promise<string> => repository.ensureSession(crypto.createHash("sha256").update(name).digest());

function applied(height: number, name = `canonical-${height}`, active = true): AppliedBlock {
  return {
    block: {
      id: hash(name), height, timestamp: 1_800_000_000 + height,
      previousblockhash: height === 0 ? null : hash(height === 100 && name === "baseline-100" ? "parent-99" : `canonical-${height - 1}`),
    },
    meal: { foodId: `food-${height % 4}`, foodName: `Meal ${height}`, reaction: "happy", pantryVersion: "generic-v1" },
    active,
  };
}

function transition(connect: AppliedBlock[], disconnect: string[] = []): WorldTransition {
  return { connect, disconnect, observedAt: new Date().toISOString(), syncStatus: "synced" };
}

async function reset(): Promise<void> {
  await pool.query("TRUNCATE world_events, moderation_audit, community_actions, block_journal, sessions, worker_leases RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM den_slots");
  await pool.query("UPDATE world_state SET world_revision = 1, chain_height = NULL, chain_hash = NULL, hatched_height = NULL, joy = 40, source = 'https://blockstream.info/api', sync_status = 'starting', last_error = NULL, observed_at = NULL");
  await pool.query("INSERT INTO den_slots(slot) VALUES ('wall'),('floor'),('corner')");
}

beforeAll(async () => { await migrate(pool); });
beforeEach(reset);
afterAll(async () => { await pool.end(); });

describe("transactional block world", () => {
  it("separates the uncredited observed baseline, awards one meal, and de-duplicates it", async () => {
    const baseline = await repository.applyTransition(transition([applied(100, "baseline-100", false)]));
    expect(baseline.pet.meals).toBe(0);
    expect(baseline.chain.height).toBe(100);
    expect(await repository.knownActiveChain()).toHaveLength(1); // Anchor only; the inactive row is not a meal.

    const welcome = applied(101);
    welcome.block.previousblockhash = hash("baseline-100");
    const fed = await repository.applyTransition(transition([welcome]));
    expect(fed.pet.meals).toBe(1);
    expect(fed.pet.lastMeal?.pantryVersion).toBe("generic-v1");
    const duplicate = await repository.applyTransition(transition([applied(101)]));
    expect(duplicate.revision).toBe(fed.revision);
    expect(duplicate.pet.meals).toBe(1);
  });

  it("rolls back a disconnected meal and preserves community contributions on replacement", async () => {
    await repository.applyTransition(transition([applied(100)]));
    await repository.applyTransition(transition([applied(101)]));
    const player = await session("reorg-player");
    await repository.applyAction(player, crypto.randomUUID(), { kind: "decorate", slot: "wall", itemId: "genesis-poster", expectedVersion: 0 });
    const before = await repository.snapshot();
    expect(before.pet.meals).toBe(2);

    const replacement = applied(101, "replacement-101");
    replacement.block.previousblockhash = hash("canonical-100");
    const after = await repository.applyTransition(transition([replacement], [hash("canonical-101")]));
    expect(after.pet.meals).toBe(2);
    expect(after.den.find((item) => item.slot === "wall")?.itemId).toBe("genesis-poster");
    const journal = await pool.query("SELECT active FROM block_journal WHERE block_hash = $1", [hash("canonical-101")]);
    expect(journal.rows[0].active).toBe(false);
  });

  it("fences stale workers without changing state and permits the new owner", async () => {
    await repository.applyTransition(transition([applied(100)]));
    const first = await acquireWorkerLease(pool, crypto.randomUUID());
    expect(first).not.toBeNull();
    await pool.query("UPDATE worker_leases SET expires_at = now() - interval '1 second' WHERE name = 'blocks'");
    const second = await acquireWorkerLease(pool, crypto.randomUUID());
    expect(second).not.toBeNull();
    const before = await repository.snapshot();
    await expect(repository.applyTransition(transition([applied(101)]), first)).rejects.toMatchObject({ statusCode: 409 });
    expect(await repository.snapshot()).toEqual(before);
    const after = await repository.applyTransition(transition([applied(101)]), second);
    expect(after.pet.meals).toBe(2);
  });

  it("marks a safe cursor behind provider data without harming the pet", async () => {
    await repository.applyTransition(transition([applied(100)]));
    const before = await repository.snapshot();
    await repository.markDegraded("transport-error: source unavailable");
    const after = await repository.snapshot();
    expect(after.chain.syncStatus).toBe("degraded");
    expect(after.pet).toEqual(before.pet);
    await repository.markHealthy();
    expect((await repository.snapshot()).chain.lastError).toBeNull();
  });

  it("resets an SSE client whose requested revision has fallen outside retained history", async () => {
    const retained = new WorldRepository(pool, 1);
    await retained.applyTransition(transition([applied(100)]));
    await retained.applyTransition(transition([applied(101)]));
    await retained.applyTransition(transition([applied(102)]));
    const latest = await retained.snapshot();
    const replay = await retained.eventsAfter(latest.revision - 2);
    expect(replay.events).toEqual([]);
    expect(replay.reset?.revision).toBe(latest.revision);
    expect(replay.reset?.chain.height).toBe(102);
  });
});

describe("community actions", () => {
  it("persists the completed result and returns the same action id on retry", async () => {
    const player = await session("retry-player");
    const key = crypto.randomUUID();
    const action: ActionRequest = { kind: "play" };
    const first = await repository.applyAction(player, key, action);
    const second = await repository.applyAction(player, key, action);
    expect(second.actionId).toBe(first.actionId);
    expect(second.duplicate).toBe(true);
    expect((await repository.snapshot()).revision).toBe(first.snapshot.revision);
    await expect(repository.applyAction(player, key, { kind: "decorate", slot: "wall", itemId: "genesis-poster", expectedVersion: 0 })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows only one winner for simultaneous edits and protects another visitor's item", async () => {
    const alice = await session("alice");
    const bob = await session("bob");
    const action: ActionRequest = { kind: "decorate", slot: "wall", itemId: "genesis-poster", expectedVersion: 0 };
    const results = await Promise.allSettled([
      repository.applyAction(alice, crypto.randomUUID(), action),
      repository.applyAction(bob, crypto.randomUUID(), action),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("No decoration was applied");
    await expect(repository.applyAction(bob, crypto.randomUUID(), { kind: "decorate", slot: "wall", itemId: "badger-poster", expectedVersion: 1 })).rejects.toMatchObject({ statusCode: 409 });
    await expect(repository.applyAction(alice, crypto.randomUUID(), { ...action, expectedVersion: 0 })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows moderator undo only while that contribution is current", async () => {
    const alice = await session("moderated-player");
    const first = await repository.applyAction(alice, crypto.randomUUID(), { kind: "decorate", slot: "floor", itemId: "orange-rug", expectedVersion: 0 });
    const undone = await repository.undoDecoration(first.actionId, "test moderation");
    expect(undone.den.find((item) => item.slot === "floor")?.itemId).toBeNull();
    expect(undone.den.find((item) => item.slot === "wall")?.itemId).toBeNull();
    await expect(repository.undoDecoration(first.actionId, "repeat")).rejects.toMatchObject({ statusCode: 409 });

    const next = await repository.applyAction(alice, crypto.randomUUID(), { kind: "decorate", slot: "wall", itemId: "badger-poster", expectedVersion: 0 });
    await repository.applyAction(alice, crypto.randomUUID(), { kind: "decorate", slot: "wall", itemId: "genesis-poster", expectedVersion: 1 });
    await expect(repository.undoDecoration(next.actionId, "superseded")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("serializes concurrent play into unique revisions with no lost world updates", async () => {
    const player = await session("busy-player");
    const actions = await Promise.all(Array.from({ length: 20 }, () => repository.applyAction(player, crypto.randomUUID(), { kind: "play" })));
    expect(new Set(actions.map((action) => action.snapshot.revision)).size).toBe(20);
    const snapshot = await repository.snapshot();
    expect(snapshot.pet.joy).toBe(100);
    const events = await pool.query("SELECT COUNT(DISTINCT revision)::int AS count FROM world_events");
    expect(events.rows[0].count).toBe(20);
  });
});
