import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.ts";
import type { AppConfig } from "../src/server/config.ts";
import { WorldRepository } from "../src/server/world/repository.ts";
import { StoryWorker } from "../src/server/story/worker.ts";

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/btc_tamagochi" });
const repository = new WorldRepository(pool);
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const quote = (change: string, time: Date) => ({
  usd: "95000", change,
  sourceUpdatedAt: new Date(time.getTime() - 60_000).toISOString(),
  receivedAt: new Date(time.getTime() - 5_000).toISOString(),
});
let demoApp: FastifyInstance | null = null;

test.beforeEach(async () => {
  fs.mkdirSync("artifacts", { recursive: true });
  await pool.query("TRUNCATE world_events, moderation_audit, community_actions, block_journal, sessions, worker_leases, story_hash_candidates, story_episodes RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM den_slots");
  await pool.query("UPDATE world_state SET world_revision = 1, chain_height = NULL, chain_hash = NULL, hatched_height = NULL, joy = 40, sync_status = 'starting', last_error = NULL, observed_at = NULL");
  await pool.query("UPDATE story_state SET activation_height = NULL, live_boundary_height = NULL, price_zone = 'baseline-required', price_change = NULL, price_usd = NULL, price_source_updated_at = NULL, price_received_at = NULL");
  await pool.query("INSERT INTO den_slots(slot) VALUES ('wall'),('floor'),('corner')");
});

test.afterEach(async () => {
  if (demoApp) await demoApp.close();
  demoApp = null;
});
test.afterAll(async () => { await pool.end(); });

test("real fiat copy preserves precision, propagates over SSE, and closes through free care", async ({ page, browser }) => {
  const config: AppConfig = {
    port: 3110, databaseUrl: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/btc_tamagochi",
    blockApiBaseUrl: "https://blockstream.info/api", pollIntervalMs: 60_000,
    moderatorToken: null, production: false, disableBlockWorker: true, disableStoryWorker: true,
  };
  demoApp = await buildApp(config, pool, { repository });
  await demoApp.listen({ host: "127.0.0.1", port: 3110 });
  await repository.evaluateStory({ price: quote("0", at(0)), now: at(0) });
  const streamReady = page.waitForResponse((response) => response.url().includes("/api/stream") && response.status() === 200);
  await page.goto("http://127.0.0.1:3110/");
  await streamReady;
  await expect(page.locator("#story-section")).toBeHidden();
  await repository.evaluateStory({ price: quote("-5.000001", at(1)), now: at(1) });
  await expect(page.locator("#story-section")).toBeVisible();
  await expect(page.locator("#story-title")).toHaveText("FIAT SNACK TRUCK");
  await expect(page.locator("#story-sub")).toHaveText("Seed-oil special.");
  await expect(page.locator("#story-fact")).toContainText("−5.0% (rounded; below −5.0)");
  await expect(page.locator("#story-doctor")).toContainText("Dr. Lumen");
  await expect(page.locator("footer")).toContainText("Badger is a cartoon");
  await page.screenshot({ path: "artifacts/story-fiat-desktop.png", fullPage: true });

  const second = await browser.newPage();
  await second.goto("http://127.0.0.1:3110/");
  await expect(second.locator("#story-section")).toBeVisible();
  await page.locator("#story-action").click();
  await expect(page.locator("#story-section")).toBeHidden();
  await expect(second.locator("#story-section")).toBeHidden();
  await expect(page.locator("#announcement")).toHaveText("WELL. No more seed-oil specials. Badger is fine.");
  await page.screenshot({ path: "artifacts/story-fiat-cared-desktop.png", fullPage: true });
  await second.close();
});

test("a real story worker publishes through production-style app composition to browser SSE", async ({ page }) => {
  const config: AppConfig = {
    port: 3110, databaseUrl: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/btc_tamagochi",
    blockApiBaseUrl: "https://blockstream.info/api", pollIntervalMs: 60_000,
    moderatorToken: null, production: false, disableBlockWorker: true,
  };
  const writer = new WorldRepository(pool);
  let currentQuote = quote("0", new Date());
  const worker = new StoryWorker(writer, config, { observe: async () => currentQuote });
  demoApp = await buildApp(config, pool, { repository: writer, worker });
  await demoApp.listen({ host: "127.0.0.1", port: 3110 });
  await expect.poll(async () => (await writer.snapshot()).story.price.status).toBe("fresh");
  const streamReady = page.waitForResponse((response) => response.url().includes("/api/stream") && response.status() === 200);
  await page.goto("http://127.0.0.1:3110/");
  await streamReady;
  await expect(page.locator("#story-section")).toBeHidden();

  currentQuote = quote("-6", new Date());
  await worker.runOnce();
  await expect(page.locator("#story-section")).toBeVisible();
  await expect(page.locator("#story-title")).toHaveText("FIAT SNACK TRUCK");
});

test("real steak copy remains readable on mobile and uses dismissal, not care", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await repository.evaluateStory({ price: quote("0", at(0)), now: at(0) });
  await repository.evaluateStory({ price: quote("6", at(1)), now: at(1) });
  await page.goto("/");
  await expect(page.locator("#story-title")).toHaveText("STEAK TRUCK");
  await expect(page.locator("#story-mood")).toContainText("Badger drank the fancy water");
  await expect(page.locator("#story-action")).toHaveText("Dismiss celebration");
  await page.screenshot({ path: "artifacts/story-steak-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator("#story-action").click();
  await expect(page.locator("#story-section")).toBeHidden();
  await expect(page.locator("#announcement")).toContainText("Badger is content");

});

test("expiry uses the approved family-specific closing line", async ({ page }) => {
  const config: AppConfig = {
    port: 3110, databaseUrl: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/btc_tamagochi",
    blockApiBaseUrl: "https://blockstream.info/api", pollIntervalMs: 60_000,
    moderatorToken: null, production: false, disableBlockWorker: true, disableStoryWorker: true,
  };
  demoApp = await buildApp(config, pool, { repository });
  await demoApp.listen({ host: "127.0.0.1", port: 3110 });
  await repository.evaluateStory({ price: quote("0", at(0)), now: at(0) });
  await repository.evaluateStory({ price: quote("-6", at(1)), now: at(1) });
  await pool.query("UPDATE story_episodes SET expires_at = $1 WHERE status = 'active'", [new Date(Date.now() + 2000)]);
  await page.goto("http://127.0.0.1:3110/");
  await expect(page.locator("#story-title")).toHaveText("FIAT SNACK TRUCK");
  await expect(page.locator("#story-section")).toBeHidden();
  await expect(page.locator("#announcement")).toHaveText("The oil wore off. Badger carries on.");
});

test("glare free care uses its approved recovery line", async ({ page }) => {
  const config: AppConfig = {
    port: 3110, databaseUrl: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/btc_tamagochi",
    blockApiBaseUrl: "https://blockstream.info/api", pollIntervalMs: 60_000,
    moderatorToken: null, production: false, disableBlockWorker: true, disableStoryWorker: true, storyDemo: true,
  };
  demoApp = await buildApp(config, pool);
  await demoApp.listen({ host: "127.0.0.1", port: 3110 });
  await page.goto("http://127.0.0.1:3110/");
  await page.locator('[data-demo-family="hash-mischief"]').click();
  await page.locator("#story-action").click();
  await expect(page.locator("#announcement")).toHaveText("WELL. The room is a better color.");
});

test("production demo actions are rejected; explicitly enabled demo scenes never claim live causes", async ({ page, request }) => {
  const denied = await request.post("/api/actions", { headers: { "Idempotency-Key": crypto.randomUUID() }, data: { kind: "story-demo", family: "price-down" } });
  expect(denied.status()).toBe(404);

  const config: AppConfig = {
    port: 3110, databaseUrl: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/btc_tamagochi",
    blockApiBaseUrl: "https://blockstream.info/api", pollIntervalMs: 60_000,
    moderatorToken: null, production: false, disableBlockWorker: true, disableStoryWorker: true, storyDemo: true,
  };
  demoApp = await buildApp(config, pool);
  await demoApp.listen({ host: "127.0.0.1", port: 3110 });
  await page.goto("http://127.0.0.1:3110/");
  await expect(page.locator("#demo-stories")).toBeVisible();
  for (const [family, title] of [["price-down", "FIAT SNACK TRUCK"], ["price-up", "STEAK TRUCK"], ["hash-mischief", "A DELIVERY"]] as const) {
    await page.locator(`[data-demo-family="${family}"]`).click();
    await expect(page.locator("#story-title")).toHaveText(title);
    await expect(page.locator("#story-state")).toContainText("DEMO");
    await expect(page.locator("#story-fact")).toHaveText("DEMO SCENARIO · no live market or block trigger");
    expect(await page.locator("#story-fact").innerText()).not.toContain("CoinGecko");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "artifacts/story-demo-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
