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
