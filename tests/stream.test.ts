import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../src/server/app.ts";
import { migrate } from "../src/server/migrate.ts";
import { WorldRepository } from "../src/server/world/repository.ts";

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/btc_tamagochi" });
beforeAll(async () => {
  await migrate(pool);
  await pool.query("TRUNCATE world_events, moderation_audit, community_actions, block_journal, sessions, worker_leases, story_hash_candidates, story_episodes RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM den_slots");
  await pool.query("UPDATE world_state SET world_revision = 1, chain_height = NULL, chain_hash = NULL, hatched_height = NULL, joy = 40, sync_status = 'starting', last_error = NULL, observed_at = NULL");
  await pool.query("UPDATE story_state SET activation_height = NULL, live_boundary_height = NULL, price_zone = 'baseline-required', price_change = NULL, price_usd = NULL, price_source_updated_at = NULL, price_received_at = NULL");
  await pool.query("INSERT INTO den_slots(slot) VALUES ('wall'),('floor'),('corner')");
});
afterAll(async () => { await pool.end(); });

it("returns a fresh snapshot over real SSE when requested history no longer exists", async () => {
  const writer = new WorldRepository(pool, 1);
  const session = await writer.ensureSession(crypto.createHash("sha256").update("sse-gap").digest());
  for (let i = 0; i < 3; i++) await writer.applyAction(session, crypto.randomUUID(), { kind: "play" });
  const current = await writer.snapshot();
  const app = await buildApp({
    port: 0,
    databaseUrl: "",
    blockApiBaseUrl: "https://blockstream.info/api",
    pollIntervalMs: 60_000,
    moderatorToken: null,
    production: false,
    disableBlockWorker: true,
  }, pool, { serveClient: false });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/stream?after=${current.revision - 2}`, { signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("event: reset")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    expect(text).toContain("event: reset");
    const line = text.split("\n").find((item) => item.startsWith("data: "));
    expect(line).toBeDefined();
    const snapshot = JSON.parse(line!.slice(6));
    expect(snapshot.revision).toBe(current.revision);
    expect(snapshot.pet.joy).toBe(current.pet.joy);
  } finally {
    await app.close();
  }
});
