import crypto from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.ts";
import type { AppConfig } from "../src/server/config.ts";
import { migrate } from "../src/server/migrate.ts";

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/btc_tamagochi" });
const config: AppConfig = {
  port: 3000,
  databaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/btc_tamagochi",
  blockApiBaseUrl: "https://blockstream.info/api",
  pollIntervalMs: 60_000,
  moderatorToken: "correct-test-moderator-token",
  production: false,
  disableBlockWorker: true,
};

beforeAll(async () => { await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE world_events, moderation_audit, community_actions, block_journal, sessions, worker_leases, story_hash_candidates, story_episodes RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM den_slots");
  await pool.query("UPDATE world_state SET world_revision = 1, chain_height = NULL, chain_hash = NULL, hatched_height = NULL, joy = 40, sync_status = 'starting', last_error = NULL, observed_at = NULL");
  await pool.query("UPDATE story_state SET activation_height = NULL, live_boundary_height = NULL, price_zone = 'baseline-required', price_change = NULL, price_usd = NULL, price_source_updated_at = NULL, price_received_at = NULL");
  await pool.query("INSERT INTO den_slots(slot) VALUES ('wall'),('floor'),('corner')");
});
afterAll(async () => { await pool.end(); });

async function testApp() {
  return buildApp(config, pool, { serveClient: false });
}

describe("HTTP security and actions", () => {
  it("sets an HttpOnly cookie, never requires a wallet, and publishes a redacted world", async () => {
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/api/world" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toMatch(/HttpOnly/);
    expect(response.headers["set-cookie"]).toMatch(/SameSite=Lax/);
    const world = response.json();
    expect(world.chain.trust).toBe("provider-reported");
    expect(world.pet.lastMeal).toBeNull();
    expect(world.den).toHaveLength(3);
    expect(JSON.stringify(world)).not.toContain("token_hash");
    await app.close();
  });

  it("rejects cross-origin mutations and accepts a same-site JSON action", async () => {
    const app = await testApp();
    const key = crypto.randomUUID();
    const common = { method: "POST" as const, url: "/api/actions", payload: { kind: "play" }, headers: { "content-type": "application/json", "idempotency-key": key } };
    const cross = await app.inject({ ...common, headers: { ...common.headers, origin: "https://attacker.example" } });
    expect(cross.statusCode).toBe(403);
    const wrongType = await app.inject({ ...common, headers: { ...common.headers, "content-type": "text/plain" } });
    expect(wrongType.statusCode).toBe(415);
    const okay = await app.inject(common);
    expect(okay.statusCode).toBe(200);
    expect(okay.json().snapshot.pet.joy).toBe(50);
    await app.close();
  });

  it("enforces the action budget through the real HTTP route", async () => {
    const app = await testApp();
    const world = await app.inject({ method: "GET", url: "/api/world" });
    const cookie = String(world.headers["set-cookie"]).split(";")[0];
    for (let i = 0; i < 20; i++) {
      const response = await app.inject({ method: "POST", url: "/api/actions", payload: { kind: "play" }, headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID(), cookie } });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "POST", url: "/api/actions", payload: { kind: "play" }, headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID(), cookie } });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    await app.close();
  });

  it("requires moderator authorization and a reason for reversible moderation", async () => {
    const app = await testApp();
    const decorate = await app.inject({ method: "POST", url: "/api/actions", payload: { kind: "decorate", slot: "wall", itemId: "genesis-poster", expectedVersion: 0 }, headers: { "content-type": "application/json, application/json", "idempotency-key": crypto.randomUUID() } });
    expect(decorate.statusCode).toBe(415);
    const accepted = await app.inject({ method: "POST", url: "/api/actions", payload: { kind: "decorate", slot: "wall", itemId: "genesis-poster", expectedVersion: 0 }, headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() } });
    expect(accepted.statusCode).toBe(200);
    const id = accepted.json().actionId;
    const denied = await app.inject({ method: "POST", url: `/api/moderation/undo/${id}`, payload: { reason: "test" }, headers: { authorization: "Bearer wrong" } });
    expect(denied.statusCode).toBe(401);
    const undone = await app.inject({ method: "POST", url: `/api/moderation/undo/${id}`, payload: { reason: "test" }, headers: { authorization: "Bearer correct-test-moderator-token" } });
    expect(undone.statusCode).toBe(200);
    expect(undone.json().snapshot.den.find((item: { slot: string }) => item.slot === "wall")?.itemId).toBeNull();
    await app.close();
  });
});
