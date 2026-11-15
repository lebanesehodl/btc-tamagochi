import type { BlockMetadata } from "../../shared/bitcoin.js";

export type BitcoinDataErrorCode =
  | "invalid-input"
  | "invalid-response"
  | "http-error"
  | "timeout"
  | "transport-error"
  | "missing-baseline"
  | "source-behind"
  | "source-changed"
  | "baseline-unavailable";

/** Messages deliberately exclude response bodies, URLs, and upstream error text. */
export class BitcoinDataError extends Error {
  constructor(
    public readonly code: BitcoinDataErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "BitcoinDataError";
  }
}

// Application bounds, not a substitute for Bitcoin consensus validation.
const MAX_HEIGHT = 0x7fffffff;
const MAX_TIMESTAMP = 0xffffffff;
const ZERO_HASH = "0".repeat(64);

export function isBlockHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isBlockHeight(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_HEIGHT;
}

export function requireBlockHash(value: unknown): string {
  if (!isBlockHash(value)) {
    throw new BitcoinDataError("invalid-response", "Expected a lowercase 32-byte block hash.");
  }
  return value;
}

/** Copy just the fields consumed by the application. Never compare adjacent timestamps. */
export function parseBlockMetadata(value: unknown): BlockMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BitcoinDataError("invalid-response", "Expected block metadata.");
  }
  const block = value as Record<string, unknown>;
  const id = requireBlockHash(block.id);
  if (!isBlockHeight(block.height)) {
    throw new BitcoinDataError("invalid-response", "Invalid block height.");
  }
  if (!Number.isSafeInteger(block.timestamp) || (block.timestamp as number) < 0
    || (block.timestamp as number) > MAX_TIMESTAMP) {
    throw new BitcoinDataError("invalid-response", "Invalid block timestamp.");
  }
  let previousblockhash: string | null;
  if (block.height === 0) {
    if (block.previousblockhash !== undefined && block.previousblockhash !== null
      && block.previousblockhash !== ZERO_HASH) {
      throw new BitcoinDataError("invalid-response", "Genesis cannot have a nonzero parent hash.");
    }
    previousblockhash = null;
  } else {
    previousblockhash = requireBlockHash(block.previousblockhash);
  }
  if (previousblockhash === id) {
    throw new BitcoinDataError("invalid-response", "A block cannot be its own parent.");
  }
  return { id, height: block.height, timestamp: block.timestamp as number, previousblockhash };
}

export function boundedInteger(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new BitcoinDataError("invalid-input", `Invalid ${name} limit.`);
  }
  return value;
}
