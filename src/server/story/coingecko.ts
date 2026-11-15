import {
  STORY_MAX_FUTURE_SKEW_SECONDS,
  STORY_MAX_SOURCE_AGE_SECONDS,
  STORY_REBASELINE_GAP_SECONDS,
} from "../../shared/story.ts";
import type { PriceCause } from "../../shared/story.ts";

export const COINGECKO_SIMPLE_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true";
const MAX_RESPONSE_BYTES = 16 * 1024;
const NUMBER_TOKEN = "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?";

export class PriceDataError extends Error {
  constructor(readonly code: "transport" | "shape" | "stale" | "future", message: string) {
    super(message);
    this.name = "PriceDataError";
  }
}

export interface PriceObservation extends Omit<PriceCause, "kind" | "source"> {
  receivedAt: string;
}

interface DecimalParts { coefficient: bigint; scale: number }

export function parseDecimal(token: string): DecimalParts {
  const match = /^([+-]?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
  if (!match || token.length > 100) throw new PriceDataError("shape", "Invalid decimal token");
  const exponent = Number(match[4] ?? 0);
  const fraction = match[3]?.length ?? 0;
  const scale = fraction - exponent;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000 || Math.abs(scale) > 2000) {
    throw new PriceDataError("shape", "Decimal exponent is out of bounds");
  }
  const sign = match[1] === "-" ? -1n : 1n;
  return { coefficient: sign * BigInt(`${match[2]}${match[3] ?? ""}`), scale };
}

/** Exact decimal comparison; thresholds never depend on rounded text or binary floating point. */
export function compareDecimal(left: string, right: string): number {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const av = a.coefficient * 10n ** BigInt(scale - a.scale);
  const bv = b.coefficient * 10n ** BigInt(scale - b.scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

export function priceZone(change: string): "neutral" | "down" | "up" {
  if (compareDecimal(change, "-5") < 0) return "down";
  if (compareDecimal(change, "5") > 0) return "up";
  return "neutral";
}

function uniqueNumberToken(source: string, field: string): string {
  const expression = new RegExp(`"${field}"\\s*:\\s*(${NUMBER_TOKEN})`, "g");
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new PriceDataError("shape", `Expected exactly one numeric ${field}`);
  }
  return matches[0][1];
}

async function boundedBody(response: Response): Promise<string> {
  if (!response.body) throw new PriceDataError("shape", "Empty provider body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new PriceDataError("shape", "Provider response exceeds 16 KiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(merged);
}

export function parseCoinGeckoObservation(source: string, receivedAt: Date, now: Date): PriceObservation {
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { throw new PriceDataError("shape", "Provider returned invalid JSON"); }
  const bitcoin = (parsed as { bitcoin?: unknown } | null)?.bitcoin;
  if (!bitcoin || typeof bitcoin !== "object") throw new PriceDataError("shape", "Missing bitcoin quote");

  const usd = uniqueNumberToken(source, "usd");
  const change = uniqueNumberToken(source, "usd_24h_change");
  const updatedToken = uniqueNumberToken(source, "last_updated_at");
  if (!/^[0-9]+$/.test(updatedToken)) throw new PriceDataError("shape", "Source timestamp must be integer seconds");
  const updatedSeconds = Number(updatedToken);
  if (!Number.isSafeInteger(updatedSeconds) || updatedSeconds <= 0) throw new PriceDataError("shape", "Invalid source timestamp");
  if (compareDecimal(usd, "0") <= 0 || compareDecimal(usd, "1000000000") > 0) {
    throw new PriceDataError("shape", "USD price is out of bounds");
  }
  if (compareDecimal(change, "-100") <= 0 || compareDecimal(change, "1000000") > 0) {
    throw new PriceDataError("shape", "24-hour change is out of bounds");
  }

  const receivedMs = receivedAt.getTime();
  const nowMs = now.getTime();
  const sourceMs = updatedSeconds * 1000;
  if (!Number.isSafeInteger(receivedMs) || !Number.isSafeInteger(nowMs) || Number.isNaN(sourceMs)) {
    throw new PriceDataError("shape", "Invalid local or source clock");
  }
  const ageSeconds = (nowMs - sourceMs) / 1000;
  if (ageSeconds > STORY_MAX_SOURCE_AGE_SECONDS) throw new PriceDataError("stale", "Provider quote is stale");
  if (ageSeconds < -STORY_MAX_FUTURE_SKEW_SECONDS) throw new PriceDataError("future", "Provider quote is too far in the future");
  if (nowMs - receivedMs > STORY_REBASELINE_GAP_SECONDS * 1000 || receivedMs > nowMs + 1000) {
    throw new PriceDataError("stale", "Quote receipt time is discontinuous");
  }
  return {
    usd,
    change,
    sourceUpdatedAt: new Date(sourceMs).toISOString(),
    receivedAt: receivedAt.toISOString(),
  };
}

export class CoinGeckoPriceSource {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async observe(_now = new Date()): Promise<PriceObservation> {
    let response: Response;
    try {
      response = await this.fetcher(COINGECKO_SIMPLE_PRICE_URL, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw new PriceDataError("transport", error instanceof Error ? error.message.slice(0, 160) : "Provider request failed");
    }
    if (response.status !== 200) throw new PriceDataError("transport", `Provider HTTP ${response.status}`);
    const body = await boundedBody(response);
    // Validate age/skew after the response has arrived, not against the request-start clock.
    const receivedAt = new Date();
    return parseCoinGeckoObservation(body, receivedAt, receivedAt);
  }
}
