import crypto from "node:crypto";
import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import type { AppliedBlock } from "../src/shared/world.ts";
import { WorldRepository } from "../src/server/world/repository.ts";
import { buildApp } from "../src/server/app.ts";

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/btc_tamagochi" });
const repository = new WorldRepository(pool);
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const pantry = [
  { id: "apple", name: "Crunchy apple", reaction: "happy" },
  { id: "berries", name: "Berry bowl", reaction: "curious" },
  { id: "porridge", name: "Warm porridge", reaction: "sleepy" },
  { id: "honey-toast", name: "Honey toast", reaction: "happy" },
] as const;
function applied(height: number): AppliedBlock {
  const item = pantry[height % pantry.length]!;
  return {
    block: { id: digest(`block-${height}`), height, timestamp: 1_800_000_000 + height, previousblockhash: digest(height === 100 ? "parent-99" : `block-${height - 1}`) },
    meal: { foodId: item.id, foodName: item.name, reaction: item.reaction, pantryVersion: "generic-v1" },
    active: true,
  };
}

test.beforeEach(async () => {
  fs.mkdirSync("artifacts", { recursive: true });
  await pool.query("TRUNCATE world_events, moderation_audit, community_actions, block_journal, sessions, worker_leases RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM den_slots");
  await pool.query("UPDATE world_state SET world_revision = 1, chain_height = NULL, chain_hash = NULL, hatched_height = NULL, joy = 40, source = 'https://blockstream.info/api', sync_status = 'starting', last_error = NULL, observed_at = NULL");
  await pool.query("INSERT INTO den_slots(slot) VALUES ('wall'),('floor'),('corner')");
  await repository.applyTransition({ disconnect: [], connect: [applied(100)], observedAt: new Date("2026-01-01T00:00:00Z").toISOString(), syncStatus: "synced" });
  await repository.applyTransition({ disconnect: [], connect: [applied(101)], observedAt: new Date("2026-01-01T00:10:00Z").toISOString(), syncStatus: "synced" });
});

test.afterAll(async () => { await pool.end(); });

test("desktop meal, play, decoration, and inspected production render", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page).toHaveTitle(/Ratel/);
  await expect(page.getByRole("heading", { name: "Satoshi’s little world.", exact: true })).toBeVisible();
  await page.getByText("How meals arrive", { exact: true }).click();
  await expect(page.locator("#block-hash")).toBeVisible();
  await expect(page.locator("#observed-at")).toContainText("Observed");
  await page.getByText("How meals arrive", { exact: true }).click();
  await expect(page.locator(".meal-details")).not.toHaveAttribute("open", "");
  await expect(page.locator("#badger")).toBeVisible();
  await expect(page.locator("#badger")).toHaveAttribute("src", "/satoshi/satoshi-neutral-48.png");
  await page.locator("#badger").evaluate((image: HTMLImageElement) => image.decode());
  expect(await page.locator("#badger").evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight }))).toEqual({ width: 48, height: 48 });
  await expect(page.locator("#block-height")).toHaveText("#101");
  await expect(page.locator("#food-name")).toHaveText("Berry bowl");
  for (const joy of [50, 60, 70, 80]) {
    await page.getByRole("button", { name: /Play with Satoshi/ }).click();
    await expect(page.locator("#joy-label")).toHaveText(`JOY ${joy}/100`);
  }
  await expect(page.locator("#mood-label")).toHaveText("JOYFUL");
  await expect(page.locator("#badger")).toHaveAttribute("src", "/satoshi/satoshi-joyful-48.png");
  await page.locator("#badger").evaluate((image: HTMLImageElement) => image.decode());
  await page.locator('[data-slot="wall"] [data-item="genesis-poster"]').click();
  await expect(page.locator("#den-wall")).toHaveClass(/genesis-poster/);
  await page.screenshot({ path: "artifacts/desktop.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("a second anonymous visitor receives live changes", async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const a = await first.newPage();
  const b = await second.newPage();
  await a.goto("/");
  await b.goto("/");
  await expect(a.locator("#block-height")).toHaveText("#101");
  await expect(b.locator("#joy-label")).toHaveText("JOY 40/100");
  for (const joy of [50, 60, 70, 80]) {
    await a.getByRole("button", { name: /Play with Satoshi/ }).click();
    await expect(a.locator("#joy-label")).toHaveText(`JOY ${joy}/100`);
  }
  await expect(b.locator("#joy-label")).toHaveText("JOY 80/100");
  await expect(b.locator("#mood-label")).toHaveText("JOYFUL");
  await expect(b.locator("#badger")).toHaveAttribute("src", "/satoshi/satoshi-joyful-48.png");
  await b.locator("#badger").evaluate((image: HTMLImageElement) => image.decode());
  await a.locator('[data-slot="wall"] [data-item="genesis-poster"]').click();
  await expect(b.locator("#den-wall")).toHaveClass(/genesis-poster/);
  await expect(b.locator('[data-slot="wall"] [data-item="badger-poster"]')).toBeDisabled();
  await b.screenshot({ path: "artifacts/second-visitor.png", fullPage: true });

  await b.getByRole("button", { name: /Play with Satoshi/ }).click();
  await expect(a.locator("#joy-label")).toHaveText("JOY 90/100");
  await first.close();
  await second.close();
});

test("the actual browser SSE connection reconnects after the server drops its socket", async ({ page, browser }) => {
  const app = await buildApp({
    port: 3102,
    databaseUrl: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/btc_tamagochi",
    blockApiBaseUrl: "https://blockstream.info/api", pollIntervalMs: 60_000,
    moderatorToken: "local-browser-test-moderator", production: false, disableBlockWorker: true,
  }, pool);
  const visitor = await browser.newContext();
  const other = await visitor.newPage();
  try {
    await app.listen({ host: "127.0.0.1", port: 3102 });
    await page.goto("http://127.0.0.1:3102/");
    await expect(page.locator("#block-height")).toHaveText("#101");
    await expect(page.locator("#connection-label")).toHaveText("Live on Bitcoin time");
    const reconnect = page.waitForRequest((request) => request.url().includes("/api/stream?after="), { timeout: 15_000 });
    app.server.closeAllConnections();
    await reconnect;
    await other.goto("http://127.0.0.1:3102/");
    await other.getByRole("button", { name: /Play with Satoshi/ }).click();
    await expect(page.locator("#joy-label")).toHaveText("JOY 50/100");
  } finally {
    await visitor.close();
    await app.close();
  }
});

test("a committed new block feeds live and twelve blocks evolve the cub", async ({ page }) => {
  const app = await buildApp({
    port: 3103,
    databaseUrl: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/btc_tamagochi",
    blockApiBaseUrl: "https://blockstream.info/api", pollIntervalMs: 60_000,
    moderatorToken: null, production: false, disableBlockWorker: true,
  }, pool, { repository });
  try {
    await app.listen({ host: "127.0.0.1", port: 3103 });
    await page.goto("http://127.0.0.1:3103/");
    await expect(page.locator("#food-name")).toHaveText("Berry bowl");
    await repository.applyTransition({ disconnect: [], connect: [applied(102)], observedAt: new Date("2026-01-01T00:20:00Z").toISOString(), syncStatus: "synced" });
    await expect(page.locator("#block-height")).toHaveText("#102");
    await expect(page.locator("#food-name")).toHaveText("Warm porridge");
    await expect(page.locator("#meal-count")).toHaveText("3");
    for (const joy of [50, 60, 70, 80]) {
      await page.getByRole("button", { name: /Play with Satoshi/ }).click();
      await expect(page.locator("#joy-label")).toHaveText(`JOY ${joy}/100`);
    }
    await expect(page.locator("#mood-label")).toHaveText("JOYFUL");
    await repository.applyTransition({ disconnect: [], connect: Array.from({ length: 10 }, (_, index) => applied(index + 103)), observedAt: new Date("2026-01-01T02:00:00Z").toISOString(), syncStatus: "synced" });
    await expect(page.locator("#pet-stage")).toHaveText("ROWDY");
    await expect(page.locator("#badger")).toHaveAttribute("src", "/satoshi/satoshi-rowdy-48.png");
    await page.locator("#badger").evaluate((image: HTMLImageElement) => image.decode());
    await expect(page.locator("#growth-label")).toHaveText("Evolved after 12 blocks together.");
    await expect(page.locator("#announcement")).toHaveText("Satoshi is a rowdy badger now. Twelve blocks did it.");
    await page.screenshot({ path: "artifacts/evolved.png", fullPage: true });
  } finally {
    await app.close();
  }
});

test("mobile layout has no horizontal overflow and preserves controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#badger")).toBeVisible();
  await expect(page.locator("#badger")).toHaveAttribute("src", "/satoshi/satoshi-neutral-48.png");
  await page.locator("#badger").evaluate((image: HTMLImageElement) => image.decode());
  expect(await page.locator("#badger").evaluate((image) => getComputedStyle(image).imageRendering)).toBe("pixelated");
  await expect(page.locator("#block-height")).toHaveText("#101");
  await page.locator('[data-slot="floor"] [data-item="orange-rug"]').scrollIntoViewIfNeeded();
  await page.locator('[data-slot="floor"] [data-item="orange-rug"]').click();
  await expect(page.locator("#den-floor")).toHaveClass(/orange-rug/);
  await page.screenshot({ path: "artifacts/mobile.png", fullPage: true });
  const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.viewport);
});
