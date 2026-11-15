export const EVOLUTION_AFTER_BLOCKS = 12;
export const DEN_SLOTS = ["wall", "floor", "corner"] as const;
export type DenSlot = (typeof DEN_SLOTS)[number];
export type Reaction = "happy" | "curious" | "sleepy";

export interface MealView {
  blockHash: string;
  height: number;
  timestamp: number;
  foodId: string;
  foodName: string;
  reaction: Reaction;
  pantryVersion: string;
}

export interface DenItemView {
  slot: DenSlot;
  itemId: string | null;
  version: number;
}

export interface WorldSnapshot {
  schema: 1;
  revision: number;
  pet: {
    stage: "cub" | "rowdy";
    mood: "hungry" | "content" | "joyful";
    joy: number;
    fullness: number;
    growthBlocks: number;
    nextEvolutionAt: number | null;
    hatchedAtHeight: number | null;
    meals: number;
    lastMeal: MealView | null;
  };
  den: DenItemView[];
  chain: {
    height: number | null;
    hash: string | null;
    source: string;
    observedAt: string | null;
    syncStatus: "starting" | "synced" | "catching-up" | "degraded" | "paused";
    lastError: string | null;
    trust: "provider-reported";
  };
}

export interface AppliedBlock {
  block: {
    id: string;
    height: number;
    timestamp: number;
    previousblockhash: string | null;
  };
  meal: {
    foodId: string;
    foodName: string;
    reaction: Reaction;
    pantryVersion: string;
  };
  /** An inactive journal row can establish the initial cursor without awarding a historical meal. */
  active?: boolean;
}

export interface WorldTransition {
  disconnect: string[];
  connect: AppliedBlock[];
  observedAt: string;
  syncStatus: WorldSnapshot["chain"]["syncStatus"];
}

export type ActionRequest =
  | { kind: "play" }
  | { kind: "decorate"; slot: DenSlot; itemId: string; expectedVersion: number };

export interface ActionResponse {
  actionId: string;
  duplicate: boolean;
  snapshot: WorldSnapshot;
}
