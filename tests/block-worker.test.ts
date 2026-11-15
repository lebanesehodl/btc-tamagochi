import crypto from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { BlockMetadata, BlockSource } from "../src/shared/bitcoin.ts";
import { selectsHashMischief } from "../src/server/story/selector.ts";
import { BlockWorker } from "../src/server/block-worker.ts";
import type { AppConfig } from "../src/server/config.ts";
import { migrate } from "../src/server/migrate.ts";
import { WorldRepository } from "../src/server/world/repository.ts";
import { BitcoinDataError } from "../src/server/bitcoin/index.ts";
import { acquireWorkerLease, type WorkerLease } from "../src/server/worker-lease.ts";

const hash = (name: string) => crypto.createHash("sha256").update(name).digest("hex");
const block = (height: number, name = `block-${height}`): BlockMetadata => ({
  id: hash(name), height, timestamp: 1_800_000_000 + height,
  previousblockhash: height === 100 ? hash("parent-99") : hash(`block-${height - 1}`),
});

class FakeSource implements BlockSource {
  readonly blocks = new Map<number, BlockMetadata>([[100, block(100)]]);
  tip = 100;
  offline = false;
  async getTipHash() { if (this.offline) throw new BitcoinDataError("transport-error", "offline"); return this.blocks.get(this.tip)!.id; }
  async getBlockByHash(id: string) {
    if (this.offline) throw new BitcoinDataError("transport-error", "offline");
    const found = [...this.blocks.values()].find((item) => item.id === id);
    if (!found) throw new Error("missing fixture");
    return found;
  }
  async getHashByHeight(height: number) { if (this.offline) throw new BitcoinDataError("transport-error", "offline"); return this.blocks.get(height)!.id; }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/btc_tamagochi" });
const repository = new WorldRepository(pool);
const config: AppConfig = { port: 3000, databaseUrl: "", blockApiBaseUrl: "https://blockstream.info/api", pollIntervalMs: 60_000, moderatorToken: null, production: false, disableBlockWorker: true };

beforeAll(async () => { await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE world_events, moderation_audit, community_actions, block_journal, sessions, worker_leases, story_hash_candidates, story_episodes RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM den_slots");
  await pool.query("UPDATE world_state SET world_revision = 1, chain_height = NULL, chain_hash = NULL, hatched_height = NULL, joy = 40, source = 'https://blockstream.info/api', sync_status = 'starting', last_error = NULL, observed_at = NULL");
  await pool.query("UPDATE story_state SET activation_height = NULL, live_boundary_height = NULL, price_zone = 'baseline-required', price_change = NULL, price_usd = NULL, price_source_updated_at = NULL, price_received_at = NULL");
  await pool.query("INSERT INTO den_slots(slot) VALUES ('wall'),('floor'),('corner')");
});
afterAll(async () => { await pool.end(); });

async function seedPendingPreShutdownHash(): Promise<{ source: FakeSource; beforeRevision: number }> {
  const source = new FakeSource();
  const original = new BlockWorker(repository, config, source);
  await original.runOnce();
  let selected = block(101, "restart-selected-0");
  for (let attempt = 1; !selectsHashMischief(selected.id); attempt++) selected = block(101, `restart-selected-${attempt}`);
  const second = { ...block(102), previousblockhash: selected.id };
  const third = { ...block(103), previousblockhash: second.id };
  for (const next of [selected, second, third]) {
    source.blocks.set(next.height, next);
    source.tip = next.height;
    await original.runOnce();
  }
  return { source, beforeRevision: (await repository.snapshot()).revision };
}

it("retains the uncredited hatch anchor through first-meal and multi-meal forks and canonical replay", async () => {
  const source = new FakeSource();
  const worker = new BlockWorker(repository, config, source);
  await worker.runOnce();
  expect((await repository.knownActiveChain()).map((block) => block.height)).toEqual([100]);

  const canonical101 = block(101);
  source.blocks.set(101, canonical101);
  source.tip = 101;
  await worker.runOnce();
  const creditedFirst = await repository.snapshot();
  expect(creditedFirst.pet).toMatchObject({ meals: 1, growthBlocks: 1, stage: "cub", nextEvolutionAt: 112 });
  expect((await repository.knownActiveChain()).map((block) => block.height)).toEqual([100, 101]);

  const fork101 = block(101, "fork-first-101");
  source.blocks.set(101, fork101);
  await worker.runOnce();
  const firstFork = await repository.snapshot();
  expect(firstFork.chain.hash).toBe(fork101.id);
  expect(firstFork.pet).toMatchObject({ meals: 1, growthBlocks: 1, stage: "cub" });
  expect(firstFork.pet.lastMeal?.blockHash).toBe(fork101.id);
  expect((await pool.query("SELECT active FROM block_journal WHERE height = 100")).rows).toEqual([{ active: false }]);

  source.blocks.set(101, canonical101);
  await worker.runOnce();
  const replayedFirst = await repository.snapshot();
  expect(replayedFirst.chain.hash).toBe(canonical101.id);
  expect(replayedFirst.pet).toEqual(creditedFirst.pet);
  await worker.runOnce();
  expect((await repository.snapshot()).revision).toBe(replayedFirst.revision);

  const canonical102 = block(102);
  source.blocks.set(102, canonical102);
  source.tip = 102;
  await worker.runOnce();
  const creditedTwo = await repository.snapshot();
  expect(creditedTwo.pet).toMatchObject({ meals: 2, growthBlocks: 2, stage: "cub" });
  expect((await repository.knownActiveChain()).map((block) => block.height)).toEqual([100, 101, 102]);

  // Replace both credited blocks while retaining the original uncredited parent at 100.
  const multiFork101 = block(101, "fork-multi-101");
  const multiFork102 = { ...block(102, "fork-multi-102"), previousblockhash: multiFork101.id };
  source.blocks.set(101, multiFork101);
  source.blocks.set(102, multiFork102);
  await worker.runOnce();
  const multiFork = await repository.snapshot();
  expect(multiFork.chain.hash).toBe(multiFork102.id);
  expect({ ...multiFork.pet, lastMeal: null }).toEqual({ ...creditedTwo.pet, lastMeal: null });
  expect(multiFork.pet.lastMeal?.blockHash).toBe(multiFork102.id);

  source.blocks.set(101, canonical101);
  source.blocks.set(102, canonical102);
  await worker.runOnce();
  const replayedMulti = await repository.snapshot();
  expect(replayedMulti.chain.hash).toBe(canonical102.id);
  expect(replayedMulti.pet).toEqual(creditedTwo.pet);
  expect((await pool.query("SELECT active FROM block_journal WHERE height = 100")).rows).toEqual([{ active: false }]);
  await worker.runOnce();
  const duplicateReplay = await repository.snapshot();
  expect(duplicateReplay.pet).toEqual(replayedMulti.pet);
  expect(duplicateReplay.revision).toBe(replayedMulti.revision);
});

it("establishes a fresh story boundary on restart with persisted synced state and an unchanged tip", async () => {
  const { source, beforeRevision } = await seedPendingPreShutdownHash();
  const before = await repository.snapshot();
  expect(before.chain.syncStatus).toBe("synced");
  expect(Number((await pool.query("SELECT live_boundary_height FROM story_state")).rows[0].live_boundary_height)).toBe(100);
  expect((await pool.query("SELECT status FROM story_hash_candidates WHERE height = 101")).rows[0].status).toBe("pending");

  // The old in-process fixture keeps its lease after runOnce(); a real restart takes over only after fencing expires.
  await pool.query("UPDATE worker_leases SET expires_at = now() - interval '1 second'");
  const restarted = new BlockWorker(repository, config, source);
  restarted.start();
  try {
    await expect.poll(async () => Number((await pool.query("SELECT live_boundary_height FROM story_state")).rows[0].live_boundary_height), { timeout: 5000 }).toBe(103);
  } finally {
    await restarted.stop();
  }
  const after = await repository.evaluateStory();
  expect(after.revision).toBe(beforeRevision + 1);
  expect(after.story.episode).toBeNull();
  expect((await pool.query("SELECT status FROM story_hash_candidates WHERE height = 101")).rows[0].status).toBe("consumed");

  const priorLease = await pool.query("SELECT owner, fencing_token FROM worker_leases WHERE name = 'blocks'");
  const staleLease = { owner: priorLease.rows[0].owner as string, fencingToken: Number(priorLease.rows[0].fencing_token) };
  await pool.query("UPDATE worker_leases SET expires_at = now() - interval '1 second'");
  await expect(repository.markHealthy(new Date().toISOString(), true, staleLease)).rejects.toMatchObject({ statusCode: 409 });
  expect((await repository.snapshot()).revision).toBe(after.revision);
  expect(Number((await pool.query("SELECT live_boundary_height FROM story_state")).rows[0].live_boundary_height)).toBe(103);
});

it("blocks mature hash activation while a new worker is still waiting for startup reconciliation", async () => {
  await seedPendingPreShutdownHash();
  // Construction closes the shared repository gate before start() yields to the story worker.
  new BlockWorker(repository, config, new FakeSource());
  const gated = await repository.evaluateStory({ price: null });
  expect(gated.story.episode).toBeNull();
  expect(gated.chain.syncStatus).toBe("synced");
  expect((await pool.query("SELECT status FROM story_hash_candidates WHERE height = 101")).rows[0].status).toBe("consumed");
  expect((await pool.query("SELECT price_zone FROM story_state")).rows[0].price_zone).toBe("baseline-required");
});

it.each(["bootstrap", "no-op", "connected-block"] as const)("fails closed on %s if renewal loses the lease during a provider read", async (mode) => {
  const source = new FakeSource();
  const readTip = source.getTipHash.bind(source);
  let enteredRead!: () => void;
  let releaseRead!: () => void;
  const entered = new Promise<void>((resolve) => { enteredRead = resolve; });
  const held = new Promise<void>((resolve) => { releaseRead = resolve; });
  let blockReads = false;
  source.getTipHash = async () => {
    if (blockReads) { enteredRead(); await held; }
    return readTip();
  };
  const worker = new BlockWorker(repository, config, source);
  if (mode !== "bootstrap") await worker.runOnce();
  if (mode === "connected-block") {
    source.blocks.set(101, block(101));
    source.tip = 101;
  }
  await repository.markDegraded("fixture pause", "paused");
  const before = await repository.snapshot();

  blockReads = true;
  const running = worker.runOnce();
  await entered;
  await pool.query("UPDATE worker_leases SET expires_at = now() - interval '1 second'");
  expect(await acquireWorkerLease(pool, crypto.randomUUID())).not.toBeNull();
  // This is the renewal outcome under review: mutable worker ownership is now absent.
  (worker as unknown as { lease: WorkerLease | null }).lease = null;
  releaseRead();
  await expect(running).rejects.toMatchObject({ statusCode: 409 });

  const after = await repository.snapshot();
  expect(after.chain.syncStatus).toBe("paused");
  expect(after.revision).toBe(before.revision);
  expect(after.chain.height).toBe(mode === "bootstrap" ? null : 100);
  expect(after.pet.meals).toBe(0);
  expect((await pool.query("SELECT live_boundary_height FROM story_state")).rows[0].live_boundary_height)
    .toBe(mode === "bootstrap" ? null : "100");
  expect((await pool.query("SELECT count(*)::int AS n FROM block_journal WHERE height = 101")).rows[0].n).toBe(0);
});

it("evolves after twelve credited blocks from an uncredited baseline, deduplicates polls, and replays a reorg", async () => {
  const source = new FakeSource();
  const worker = new BlockWorker(repository, config, source);
  await worker.runOnce();
  let snapshot = await repository.snapshot();
  expect(snapshot.pet).toMatchObject({ meals: 0, growthBlocks: 0, stage: "cub", hatchedAtHeight: 100, nextEvolutionAt: 112 });
  expect(snapshot.pet.lastMeal).toBeNull();
  expect((await pool.query("SELECT active FROM block_journal WHERE height = 100")).rows).toEqual([{ active: false }]);

  await worker.runOnce();
  const duplicateBaseline = await repository.snapshot();
  expect(duplicateBaseline.pet).toEqual(snapshot.pet);
  expect(duplicateBaseline.revision).toBe(snapshot.revision);

  for (let height = 101; height <= 111; height += 1) source.blocks.set(height, block(height));
  source.tip = 111;
  await worker.runOnce();
  snapshot = await repository.snapshot();
  expect(snapshot.chain.height).toBe(111);
  expect(snapshot.pet).toMatchObject({ meals: 11, growthBlocks: 11, stage: "cub", nextEvolutionAt: 112 });

  await worker.runOnce();
  const duplicateEleven = await repository.snapshot();
  expect(duplicateEleven.pet).toEqual(snapshot.pet);
  expect(duplicateEleven.revision).toBe(snapshot.revision);

  source.blocks.set(112, block(112));
  source.tip = 112;
  await worker.runOnce();
  snapshot = await repository.snapshot();
  expect(snapshot.chain.height).toBe(112);
  expect(snapshot.pet).toMatchObject({ meals: 12, growthBlocks: 12, stage: "rowdy", nextEvolutionAt: null });

  const canonical112 = source.blocks.get(112)!;
  source.blocks.set(112, block(112, "fork-112"));
  await worker.runOnce();
  const fork = await repository.snapshot();
  expect(fork.chain.hash).toBe(source.blocks.get(112)!.id);
  // Reorg changes the meal's block identity, not how many connected meals remain credited.
  expect({ ...fork.pet, lastMeal: null }).toEqual({ ...snapshot.pet, lastMeal: null });
  expect(fork.pet.lastMeal?.blockHash).toBe(fork.chain.hash);
  expect((await pool.query("SELECT active FROM block_journal WHERE block_hash = $1", [canonical112.id])).rows).toEqual([{ active: false }]);

  source.blocks.set(112, canonical112);
  await worker.runOnce();
  const replayed = await repository.snapshot();
  expect(replayed.chain.hash).toBe(canonical112.id);
  expect(replayed.pet).toEqual(snapshot.pet);
  expect(replayed.pet.lastMeal?.blockHash).toBe(canonical112.id);
  await worker.runOnce();
  const duplicateReplay = await repository.snapshot();
  expect(duplicateReplay.pet).toEqual(replayed.pet);
  expect(duplicateReplay.revision).toBe(replayed.revision);

  const meal = snapshot.pet.lastMeal;
  if (!meal) throw new Error("Expected the twelfth block to have a credited meal");
  const rolledBack = await repository.applyTransition({
    disconnect: [canonical112.id], connect: [], observedAt: new Date().toISOString(), syncStatus: "synced",
  });
  expect(rolledBack.pet).toMatchObject({ meals: 11, growthBlocks: 11, stage: "cub", nextEvolutionAt: 112 });
  const reconnected = await repository.applyTransition({
    disconnect: [], connect: [{ block: canonical112, meal: {
      foodId: meal.foodId, foodName: meal.foodName, reaction: meal.reaction, pantryVersion: meal.pantryVersion,
    } }], observedAt: new Date().toISOString(), syncStatus: "synced",
  });
  expect(reconnected.pet).toEqual(snapshot.pet);
  expect(reconnected.pet.lastMeal?.blockHash).toBe(canonical112.id);
  await worker.runOnce();
  const duplicateReconnected = await repository.snapshot();
  expect(duplicateReconnected.pet).toEqual(reconnected.pet);
  expect(duplicateReconnected.revision).toBe(reconnected.revision);
});

it("bootstraps without historical awards, catches up only new blocks, and preserves state through outages", async () => {
  const source = new FakeSource();
  const worker = new BlockWorker(repository, config, source);
  await worker.runOnce();
  let snapshot = await repository.snapshot();
  expect(snapshot.chain.height).toBe(100);
  expect(snapshot.pet.meals).toBe(0);

  await repository.markDegraded("old source error");
  await worker.runOnce();
  snapshot = await repository.snapshot();
  expect(snapshot.chain.syncStatus).toBe("synced");
  expect(snapshot.chain.lastError).toBeNull();
  expect(snapshot.pet.meals).toBe(0);

  source.blocks.set(101, block(101));
  source.blocks.set(102, block(102));
  source.tip = 102;
  await worker.runOnce();
  snapshot = await repository.snapshot();
  expect(snapshot.pet.meals).toBe(2);
  expect(snapshot.pet.lastMeal?.height).toBe(102);
  expect(snapshot.chain.syncStatus).toBe("synced");

  source.offline = true;
  await expect(worker.runOnce()).rejects.toMatchObject({ code: "transport-error" });
  const after = await repository.snapshot();
  expect(after.pet).toEqual(snapshot.pet);
  expect(after.chain.hash).toBe(snapshot.chain.hash);
});
