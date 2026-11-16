export interface AppConfig {
  port: number;
  databaseUrl: string;
  blockApiBaseUrl: string;
  pollIntervalMs: number;
  moderatorToken: string | null;
  production: boolean;
  disableBlockWorker: boolean;
  disableStoryWorker?: boolean;
  storyDemo?: boolean;
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return {
    port: positiveInteger("PORT", env.PORT, 3000),
    databaseUrl,
    blockApiBaseUrl: env.BLOCK_API_BASE_URL ?? "https://blockstream.info/api",
    pollIntervalMs: positiveInteger("POLL_INTERVAL_MS", env.POLL_INTERVAL_MS, 60_000),
    moderatorToken: env.MODERATOR_TOKEN || null,
    production: env.NODE_ENV === "production",
    disableBlockWorker: env.DISABLE_BLOCK_WORKER === "true",
    disableStoryWorker: env.DISABLE_STORY_WORKER === "true",
    storyDemo: env.STORY_DEMO === "true",
  };
}
