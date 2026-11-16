export const STORY_RULE_VERSION = "story-v1";
export const STORY_EPISODE_SECONDS = 600;
export const STORY_HASH_CONFIRMATIONS = 3;
export const STORY_MAX_SOURCE_AGE_SECONDS = 300;
export const STORY_MAX_FUTURE_SKEW_SECONDS = 30;
export const STORY_REBASELINE_GAP_SECONDS = 600;

export const TRIGGER_FAMILIES = ["price-down", "price-up", "hash-mischief"] as const;
export type TriggerFamily = (typeof TRIGGER_FAMILIES)[number];
export type StoryMood = "fiat-sick" | "fed-well" | "glared";

export interface PriceCause {
  kind: "price";
  change: string;
  usd: string;
  source: "CoinGecko";
  sourceUpdatedAt: string;
  receivedAt: string;
}

export interface HashCause {
  kind: "hash";
  blockHash: string;
  height: number;
  storyVersion: typeof STORY_RULE_VERSION;
}

export interface DemoCause {
  kind: "demo";
}

export type StoryCause = PriceCause | HashCause | DemoCause;

export interface StoryEpisodeView {
  id: string;
  family: TriggerFamily;
  mood: StoryMood;
  demo: boolean;
  startedAt: string;
  expiresAt: string;
  cause: StoryCause;
}

export interface StoryView {
  ruleVersion: typeof STORY_RULE_VERSION;
  activationHeight: number | null;
  episode: StoryEpisodeView | null;
  demoEnabled: boolean;
  price: {
    source: "CoinGecko";
    pair: "BTC/USD";
    window: "rolling-24h";
    status: "fresh" | "unavailable";
    sourceUpdatedAt: string | null;
    observedAt: string | null;
  };
}

export function moodForFamily(family: TriggerFamily): StoryMood {
  return family === "price-down" ? "fiat-sick" : family === "price-up" ? "fed-well" : "glared";
}
