import { describe, expect, it } from "vitest";
import type { BlockMetadata } from "../src/shared/bitcoin.js";
import { GENERIC_PANTRY, PANTRY_VERSION, mealForBlock } from "../src/server/bitcoin/index.js";

const block: BlockMetadata = {
  id: "1".repeat(64), height: 100, timestamp: 1_700_000_000, previousblockhash: "2".repeat(64),
};

describe("immutable versioned generic pantry", () => {
  it("pins the v1 cycle so accidental edits break replay tests", () => {
    expect(PANTRY_VERSION).toBe("generic-v1");
    expect(GENERIC_PANTRY.map((item) => item.id)).toEqual(["apple", "berries", "porridge", "honey-toast"]);
    expect(Array.from({ length: 8 }, (_, n) => mealForBlock({ ...block, height: 100 + n }).foodId))
      .toEqual(["apple", "berries", "porridge", "honey-toast", "apple", "berries", "porridge", "honey-toast"]);
    expect(Object.isFrozen(GENERIC_PANTRY)).toBe(true);
    expect(GENERIC_PANTRY.every(Object.isFrozen)).toBe(true);
  });

  it("replays exactly and persists the menu version with the originating block identity", () => {
    expect(mealForBlock(block)).toEqual({
      blockHash: block.id, height: 100, foodId: "apple", pantryVersion: "generic-v1",
    });
    expect(mealForBlock(structuredClone(block))).toEqual(mealForBlock(block));
  });

  it("does not turn timestamp changes or replacement blocks into a different food advantage", () => {
    const replacement = { ...block, id: "3".repeat(64), timestamp: 0 };
    expect(mealForBlock(replacement).foodId).toBe(mealForBlock(block).foodId);
    expect(mealForBlock(replacement).blockHash).not.toBe(mealForBlock(block).blockHash);
  });

  it("rejects unknown menu versions instead of silently substituting today's menu", () => {
    expect(() => mealForBlock(block, "future-menu")).toThrow("Unsupported pantry version");
  });

  it("rejects malformed block metadata before selecting a food", () => {
    expect(() => mealForBlock({ ...block, height: -1 })).toThrow();
  });
});
