import { Pool } from "pg";
import { buildApp } from "./app.ts";
import { BlockWorker } from "./block-worker.ts";
import { readConfig } from "./config.ts";
import { migrate } from "./migrate.ts";
import { WorldRepository } from "./world/repository.ts";
import { StoryWorker } from "./story/worker.ts";
import type { WorkerLike } from "./app.ts";

const config = readConfig();
const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
const repository = new WorldRepository(pool, 1000, config.storyDemo === true);
await migrate(pool);
const workers: WorkerLike[] = [];
if (!config.disableBlockWorker) workers.push(new BlockWorker(repository, config));
if (!config.disableStoryWorker) workers.push(new StoryWorker(repository, config));
const worker: WorkerLike = {
  async start() { await Promise.all(workers.map((worker) => worker.start())); },
  async stop() { await Promise.all(workers.map((worker) => worker.stop())); },
};
const app = await buildApp(config, pool, { worker });

await app.listen({ host: "0.0.0.0", port: config.port });
console.log(`BTC Tamagochi listening on 0.0.0.0:${config.port}`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  await pool.end();
}
process.on("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
process.on("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
