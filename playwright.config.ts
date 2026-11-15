import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    viewport: { width: 1440, height: 1000 },
    headless: true,
    trace: "retain-on-failure",
  },
  outputDir: "test-results",
  webServer: {
    command: "npm run start",
    url: "http://127.0.0.1:3100/api/world",
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/btc_tamagochi",
      BLOCK_API_BASE_URL: "https://blockstream.info/api",
      DISABLE_BLOCK_WORKER: "true",
      MODERATOR_TOKEN: "local-browser-test-moderator",
      PORT: "3100",
      NODE_ENV: "test",
    },
  },
});
