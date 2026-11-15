import crypto from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { BlockMetadata, BlockSource } from "../src/shared/bitcoin.ts";
import { BlockWorker } from "../src/server/block-worker.ts";
import type { AppConfig } from "../src/server/config.ts";
import { migrate } from "../src/server/migrate.ts";
import { WorldRepository } from "../src/server/world/repository.ts";
import { BitcoinDataError } from "../src/server/bitcoin/index.ts";

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
  await pool.query("TRUNCATE world_events, moderation_audit, community_actions, block_journal, sessions, worker_leases RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM den_slots");
  await pool.query("UPDATE world_state SET world_revision = 1, chain_height = NULL, chain_hash = NULL, hatched_height = NULL, joy = 40, source = 'https://blockstream.info/api', sync_status = 'starting', last_error = NULL, observed_at = NULL");
  await pool.query("INSERT INTO den_slots(slot) VALUES ('wall'),('floor'),('corner')");
});
afterAll(async () => { await pool.end(); });

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
