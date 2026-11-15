import crypto from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/server/migrate.ts";
import { WorldRepository } from "../src/server/world/repository.ts";
import { selectsHashMischief } from "../src/server/story/selector.ts";
import type { PriceObservation } from "../src/server/story/coingecko.ts";
import type { ActionRequest, AppliedBlock } from "../src/shared/world.ts";
import { StoryWorker } from "../src/server/story/worker.ts";
import type { AppConfig } from "../src/server/config.ts";

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/btc_tamagochi" });
const repository = new WorldRepository(pool);
const baseTime = new Date();
const at = (minutes: number) => new Date(baseTime.getTime() + minutes * 60_000);

function quote(change: string, time: Date): PriceObservation {
  return {
    usd: "95000", change,
    sourceUpdatedAt: new Date(time.getTime() - 60_000).toISOString(),
    receivedAt: new Date(time.getTime() - 5_000).toISOString(),
  };
}

function block(height: number, parent: string | undefined, selected = false): AppliedBlock {
  let nonce = 0;
  let id = "";
  do {
    const hash = crypto.createHash("sha256").update(`${height}:${nonce}`).digest("hex");
    id = height === 100 && nonce === 0 ? "f".repeat(64) : hash.padEnd(14).slice(0, 64).replace(/^.*?$/, (value) => value.padEnd(64, "a"));
    nonce++;
  } while (selected && !selectsHashMischief(id));
  return {
    block: { id, height, timestamp: 1_768_113_480, previousblockhash: parent ?? null },
    meal: { foodId: "apple", foodName: "apple", reaction: "happy", pantryVersion: "generic-v1" },
  };
}

async function apply(connect: AppliedBlock[], storyLive: boolean, disconnect: string[] = []) {
  return repository.applyTransition({ disconnect, connect, observedAt: baseTime.toISOString(), syncStatus: "synced", storyLive });
}

async function perform(action: ActionRequest) {
  const sessionId = crypto.randomUUID();
  await pool.query("INSERT INTO sessions(id, token_hash) VALUES ($1, $2)", [sessionId, sessionId]);
  return repository.applyAction(sessionId, crypto.randomUUID(), action);
}

beforeAll(async () => { await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE world_events, moderation_audit, community_actions, block_journal, sessions, worker_leases, story_hash_candidates, story_episodes RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM den_slots");
  await pool.query("UPDATE world_state SET world_revision = 1, chain_height = NULL, chain_hash = NULL, hatched_height = NULL, joy = 40, sync_status = 'starting', last_error = NULL, observed_at = NULL");
  await pool.query("UPDATE story_state SET activation_height = NULL, live_boundary_height = NULL, price_zone = 'baseline-required', price_change = NULL, price_usd = NULL, price_source_updated_at = NULL, price_received_at = NULL");
  await pool.query("INSERT INTO den_slots(slot) VALUES ('wall'),('floor'),('corner')");
  await apply([{ ...block(100, undefined), active: false }], false);
});
afterAll(async () => { await pool.end(); });

describe("price zone continuity and episodes", () => {
  it("baselines first, opens once only beyond -5, and caps that family until a later UTC date", async () => {
    expect((await repository.evaluateStory({ price: quote("-5", at(0)), now: at(0) })).story.episode).toBeNull();
    expect((await repository.evaluateStory({ price: quote("-5", at(1)), now: at(1) })).story.episode).toBeNull();
    const opened = await repository.evaluateStory({ price: quote("-5.000001", at(2)), now: at(2) });
    expect(opened.story.episode?.family).toBe("price-down");
    expect(opened.story.episode?.mood).toBe("fiat-sick");
    expect(opened.story.episode?.cause).toMatchObject({ kind: "price", change: "-5.000001" });
    expect(Date.parse(opened.story.episode!.expiresAt) - Date.parse(opened.story.episode!.startedAt)).toBe(600_000);

    const episodeId = opened.story.episode!.id;
    await repository.evaluateStory({ price: quote("-5.000001", at(2)), now: at(2) });
    expect((await pool.query("SELECT count(*)::int AS n FROM story_episodes WHERE trigger_family = 'price-down'")).rows[0].n).toBe(1);
    const sessionId = crypto.randomUUID(), idempotencyKey = crypto.randomUUID();
    await pool.query("INSERT INTO sessions(id, token_hash) VALUES ($1, $2)", [sessionId, sessionId]);
    const careAction = () => repository.applyAction(sessionId, idempotencyKey, { kind: "story-care", episodeId });
    const cared = await careAction();
    expect(cared.snapshot.story.episode).toBeNull();
    expect((await careAction()).actionId).toBe(cared.actionId);
    expect((await careAction()).snapshot.story.episode).toBeNull();

    await repository.evaluateStory({ price: quote("0", at(3)), now: at(3) });
    expect((await repository.evaluateStory({ price: quote("-8", at(4)), now: at(4) })).story.episode).toBeNull();
    const nextDay = new Date(Date.UTC(baseTime.getUTCFullYear(), baseTime.getUTCMonth(), baseTime.getUTCDate() + 1, 4, 5));
    expect((await repository.evaluateStory({ price: quote("-8", nextDay), now: nextDay })).story.episode).toBeNull();
    await repository.evaluateStory({ price: quote("0", new Date(nextDay.getTime() + 60_000)), now: new Date(nextDay.getTime() + 60_000) });
    const following = await repository.evaluateStory({ price: quote("-8", new Date(nextDay.getTime() + 120_000)), now: new Date(nextDay.getTime() + 120_000) });
    expect(following.story.episode?.family).toBe("price-down");
  }, 20_000);

  it("treats +5 as neutral and opens/dismisses a celebration only above it", async () => {
    await repository.evaluateStory({ price: quote("-6", at(0)), now: at(0) });
    expect((await repository.evaluateStory({ price: quote("5", at(1)), now: at(1) })).story.episode).toBeNull();
    const opened = await repository.evaluateStory({ price: quote("5.000001", at(2)), now: at(2) });
    expect(opened.story.episode?.family).toBe("price-up");
    expect(opened.story.episode?.mood).toBe("fed-well");
    await expect(perform({ kind: "story-care", episodeId: opened.story.episode!.id })).rejects.toMatchObject({ code: "story_no_care" });
    const closed = await perform({ kind: "story-dismiss", episodeId: opened.story.episode!.id });
    expect(closed.snapshot.story.episode).toBeNull();
    expect((await pool.query("SELECT close_reason FROM story_episodes WHERE id = $1", [opened.story.episode!.id])).rows[0].close_reason).toBe("dismissed");
  }, 15_000);

  it("consumes a candidate behind a busy story and keeps independent direction latches", async () => {
    await repository.evaluateStory({ price: quote("0", at(0)), now: at(0) });
    const opened = await repository.evaluateStory({ price: quote("-6", at(1)), now: at(1) });
    await repository.evaluateStory({ price: quote("6", at(2)), now: at(2) });
    expect((await repository.snapshot()).story.episode?.id).toBe(opened.story.episode!.id);
    await perform({ kind: "story-care", episodeId: opened.story.episode!.id });
    expect((await repository.evaluateStory({ price: quote("6", at(3)), now: at(3) })).story.episode).toBeNull();
    await repository.evaluateStory({ price: quote("0", at(4)), now: at(4) });
    expect((await repository.evaluateStory({ price: quote("7", at(5)), now: at(5) })).story.episode?.family).toBe("price-up");
  }, 15_000);

  it("does not create illness after stale data; the first fresh quote only rebaselines", async () => {
    await repository.evaluateStory({ price: quote("0", at(0)), now: at(0) });
    const stale = await repository.evaluateStory({ price: { ...quote("-8", at(1)), sourceUpdatedAt: new Date(at(1).getTime() - 301_000).toISOString() }, now: at(1) });
    expect(stale.story.episode).toBeNull();
    expect((await repository.evaluateStory({ price: quote("-8", at(2)), now: at(2) })).story.episode).toBeNull();
    expect((await repository.evaluateStory({ price: quote("-8", at(3)), now: at(3) })).story.episode).toBeNull();
    await repository.evaluateStory({ price: quote("0", at(4)), now: at(4) });
    expect((await repository.evaluateStory({ price: quote("-8", at(5)), now: at(5) })).story.episode?.family).toBe("price-down");
  }, 15_000);

  it("suppresses a zone transition across a long observation gap and rearms only after leaving", async () => {
    await repository.evaluateStory({ price: quote("0", at(0)), now: at(0) });
    expect((await repository.evaluateStory({ price: quote("-8", at(12)), now: at(12) })).story.episode).toBeNull();
    await repository.evaluateStory({ price: quote("0", at(13)), now: at(13) });
    expect((await repository.evaluateStory({ price: quote("-8", at(14)), now: at(14) })).story.episode?.family).toBe("price-down");
  });

  it("serializes concurrent evaluations into one active episode and one daily record", async () => {
    await repository.evaluateStory({ price: quote("0", at(0)), now: at(0) });
    const results = await Promise.all([1, 2, 3, 4].map((minute) => repository.evaluateStory({ price: quote(`-${minute + 5}`, at(minute)), now: at(minute) })));
    const active = results.map((result) => result.story.episode).filter(Boolean);
    expect(active).toHaveLength(4); // each ordered snapshot sees the single story; it is not four stories
    expect(new Set(active.map((episode) => episode!.id)).size).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM story_episodes WHERE status = 'active'")).rows[0].n).toBe(1);
    expect(new Set(results.map((result) => result.revision)).size).toBe(4);
  });

  it("rebaselines a newly constructed price worker before allowing a later zone entry", async () => {
    await repository.evaluateStory({ price: quote("0", at(0)), now: at(0) });
    const config: AppConfig = {
      port: 3000, databaseUrl: "", blockApiBaseUrl: "https://blockstream.info/api", pollIntervalMs: 60_000,
      moderatorToken: null, production: false, disableBlockWorker: true,
    };
    let observed = quote("-6", new Date());
    const restarted = new StoryWorker(repository, config, { observe: async () => observed });
    await restarted.runOnce();
    expect((await repository.snapshot()).story.episode).toBeNull();
    expect((await pool.query("SELECT price_zone FROM story_state")).rows[0].price_zone).toBe("down");

    observed = quote("0", new Date());
    await restarted.runOnce();
    observed = quote("-6", new Date());
    await restarted.runOnce();
    expect((await repository.snapshot()).story.episode?.family).toBe("price-down");
  });

  it("closes at ten minutes idempotently without permanent harm", async () => {
    await repository.evaluateStory({ price: quote("0", at(0)), now: at(0) });
    await repository.evaluateStory({ price: quote("-6", at(1)), now: at(1) });
    const closed = await repository.evaluateStory({ now: new Date(at(1).getTime() + 600_000) });
    expect(closed.story.episode).toBeNull();
    expect(closed.pet.joy).toBe(40);
    expect((await pool.query("SELECT close_reason FROM story_episodes")).rows[0].close_reason).toBe("expired");
    expect((await repository.evaluateStory({ now: new Date(at(1).getTime() + 601_000) })).story.episode).toBeNull();
  });
});

describe("hash candidates and authoritative collisions", () => {
  async function matureSelectedChain(twoCandidates = false) {
    const b101 = block(101, "f".repeat(64), true);
    const b102 = block(102, b101.block.id, twoCandidates);
    const b103 = block(103, b102.block.id);
    await apply([b101], true);
    await apply([b102], true);
    await apply([b103], true);
    if (twoCandidates) await apply([block(104, b103.block.id)], true);
    return b101;
  }

  it("waits for three confirmations and gives price precedence while consuming both inputs", async () => {
    await repository.evaluateStory({ price: quote("0", at(0)), now: at(0) });
    const causal = await matureSelectedChain();
    const opened = await repository.evaluateStory({ price: quote("-6", at(1)), now: at(1) });
    expect(opened.story.episode?.family).toBe("price-down");
    const stored = await pool.query("SELECT status FROM story_hash_candidates WHERE block_hash = $1", [causal.block.id]);
    expect(stored.rows[0].status).toBe("consumed");
  }, 15_000);

  it("selects only the first digest byte under 8, matures the lowest height once, and never reopens after reorg/replay", async () => {
    expect(selectsHashMischief("not-a-hash")).toBe(false);
    expect(selectsHashMischief("84ac4ec263509519d80c92a92f4f96e634b27b9b31142b246a75f7175531d54b")).toBe(true); // first byte 0
    expect(selectsHashMischief("a9a23279bb76c1ca835c84cc9e09c3d75c7955f59a94521da9d6facdb5f76b3f")).toBe(true); // first byte 7
    expect(selectsHashMischief("b4b46b999e78f0394edbf863365ca0f87cc1cd0e216097fa9a1cd754af6332c8")).toBe(false); // first byte 8
    const causal = await matureSelectedChain(true);
    const opened = await repository.evaluateStory({ now: at(0) });
    expect(opened.story.episode).toMatchObject({ family: "hash-mischief", mood: "glared", cause: { kind: "hash", blockHash: causal.block.id, height: 101 } });
    expect((await repository.evaluateStory({ now: at(1) })).story.episode?.id).toBe(opened.story.episode!.id);
    expect((await pool.query("SELECT count(*)::int AS n FROM story_hash_candidates WHERE status = 'consumed'")).rows[0].n).toBe(2);

    const b103 = await pool.query("SELECT height, block_hash FROM block_journal WHERE active = true ORDER BY height");
    const ordered = b103.rows.sort((a, b) => Number(b.height) - Number(a.height)).map((row) => row.block_hash);
    await apply([], false, ordered);
    expect((await repository.snapshot()).story.episode).toBeNull();
    expect((await pool.query("SELECT close_reason FROM story_episodes WHERE id = $1", [opened.story.episode!.id])).rows[0].close_reason).toBe("reorg");

    const b101 = block(101, "f".repeat(64), true);
    const b102 = block(102, b101.block.id, true);
    const b103Replay = block(103, b102.block.id);
    const b104Replay = block(104, b103Replay.block.id);
    await apply([b101, b102, b103Replay, b104Replay], false);
    await repository.evaluateStory({ now: at(2) });
    expect((await repository.snapshot()).story.episode).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS n FROM story_episodes WHERE trigger_family = 'hash-mischief'")).rows[0].n).toBe(1);
  }, 20_000);

  it("consumes mature hashes during an outage and suppresses pending candidates on no-op recovery", async () => {
    await matureSelectedChain();
    const current = (await repository.knownActiveChain()).at(-1)!;
    await apply([block(104, current.id, true)], true);
    await repository.markDegraded("fixture outage");
    const during = await repository.evaluateStory({ now: at(0) });
    expect(during.chain.syncStatus).toBe("degraded");
    expect(during.story.episode).toBeNull();
    expect((await pool.query("SELECT status FROM story_hash_candidates WHERE height = 101")).rows[0].status).toBe("consumed");
    expect((await pool.query("SELECT status FROM story_hash_candidates WHERE height = 104")).rows[0].status).toBe("pending");

    await repository.markHealthy();
    const recovered = await repository.evaluateStory({ now: at(1) });
    expect(recovered.chain.syncStatus).toBe("synced");
    expect(recovered.story.episode).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS n FROM story_hash_candidates WHERE status <> 'consumed'")).rows[0].n).toBe(0);
    expect(Number((await pool.query("SELECT live_boundary_height FROM story_state")).rows[0].live_boundary_height)).toBe(104);
  });

  it("suppresses catch-up/history rather than replaying old story events", async () => {
    const b101 = block(101, "f".repeat(64), true);
    const b102 = block(102, b101.block.id);
    const b103 = block(103, b102.block.id);
    await apply([b101, b102, b103], false);
    expect((await repository.evaluateStory({ now: at(0) })).story.episode).toBeNull();
    expect((await pool.query("SELECT status FROM story_hash_candidates")).rows[0].status).toBe("consumed");
  });
});
