import type { BlockMeal, BlockMetadata, PantryItem } from "../../shared/bitcoin.js";
import { BitcoinDataError, parseBlockMetadata } from "./validation.js";

export const PANTRY_VERSION = "generic-v1";

/** Published ordering/IDs are immutable. This is fictional food, not animal-care advice. */
export const GENERIC_PANTRY: readonly Readonly<PantryItem>[] = Object.freeze([
  Object.freeze({ id: "apple", name: "Crunchy apple", reaction: "happy" as const }),
  Object.freeze({ id: "berries", name: "Berry bowl", reaction: "curious" as const }),
  Object.freeze({ id: "porridge", name: "Warm porridge", reaction: "sleepy" as const }),
  Object.freeze({ id: "honey-toast", name: "Honey toast", reaction: "happy" as const }),
]);

/** No timestamp, randomness, brand, payment, or visitor input affects the rotation. */
export function mealForBlock(block: BlockMetadata, pantryVersion = PANTRY_VERSION): BlockMeal {
  const parsed = parseBlockMetadata(block);
  if (pantryVersion !== PANTRY_VERSION) {
    throw new BitcoinDataError("invalid-input", "Unsupported pantry version.");
  }
  const item = GENERIC_PANTRY[parsed.height % GENERIC_PANTRY.length]!;
  return { blockHash: parsed.id, height: parsed.height, foodId: item.id, pantryVersion };
}
