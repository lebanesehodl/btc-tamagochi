import { describe, expect, it } from "vitest";
import { compareDecimal, parseCoinGeckoObservation, priceZone } from "../src/server/story/coingecko.ts";

const now = new Date("2026-11-15T04:00:00Z");
const updated = Math.floor(new Date("2026-11-15T03:58:00Z").getTime() / 1000);

// Raw-number extraction preserves the original token rather than JSON.parse's binary number.
function rawBody(change: string, timestamp = updated): string {
  return `{"bitcoin":{"usd":95000,"usd_24h_change":${change},"last_updated_at":${timestamp}}}`;
}

describe("CoinGecko story quote contract", () => {
  it("uses exact unrounded decimal thresholds, including exponent notation", () => {
    expect(priceZone("-5.0")).toBe("neutral");
    expect(priceZone("5.0")).toBe("neutral");
    expect(priceZone("-5.000001")).toBe("down");
    expect(priceZone("5.000001")).toBe("up");
    expect(priceZone("-5000001e-6")).toBe("down");
    expect(compareDecimal("-5.000001", "-5")).toBeLessThan(0);
    expect(compareDecimal("5.000001e0", "5")).toBeGreaterThan(0);
  });

  it("retains original numeric tokens and validates source/receipt timestamps", () => {
    const quote = parseCoinGeckoObservation(rawBody("-5.000001"), new Date("2026-11-15T03:59:30Z"), now);
    expect(quote).toEqual({
      usd: "95000", change: "-5.000001",
      sourceUpdatedAt: "2026-11-15T03:58:00.000Z", receivedAt: "2026-11-15T03:59:30.000Z",
    });
    expect(priceZone(quote.change)).toBe("down");
  });

  it("rejects stale, future, malformed, duplicate and missing fields", () => {
    const receipt = new Date("2026-11-15T03:59:30Z");
    const ancient = updated - 301;
    expect(() => parseCoinGeckoObservation(rawBody("-6", ancient), receipt, now)).toThrowError(expect.objectContaining({ code: "stale" }));
    expect(() => parseCoinGeckoObservation(rawBody("-6", Math.floor(now.getTime() / 1000) + 31), receipt, now)).toThrowError(expect.objectContaining({ code: "future" }));
    expect(() => parseCoinGeckoObservation("not json", receipt, now)).toThrowError(expect.objectContaining({ code: "shape" }));
    expect(() => parseCoinGeckoObservation(`{"bitcoin":{"usd":1,"usd_24h_change":-6,"usd_24h_change":-7,"last_updated_at":${updated}}}`, receipt, now)).toThrowError(expect.objectContaining({ code: "shape" }));
    expect(() => parseCoinGeckoObservation(`{"bitcoin":{"usd":1,"usd_24h_change":-6,"usd_24h_change":null,"last_updated_at":${updated}}}`, receipt, now)).toThrowError(expect.objectContaining({ code: "shape" }));
    expect(() => parseCoinGeckoObservation(`{"bitcoin":{},"other_asset":{"usd":95000,"usd_24h_change":-6,"last_updated_at":${updated}}}`, receipt, now)).toThrowError(expect.objectContaining({ code: "shape" }));
    expect(() => parseCoinGeckoObservation(`{"bitcoin":{"usd":95000,"usd_24h_change":-6,"last_updated_at":${updated}},"bitcoin":{}}`, receipt, now)).toThrowError(expect.objectContaining({ code: "shape" }));
    expect(() => parseCoinGeckoObservation(`{"bitcoin":{"usd":95000,"usd_24h_change":"-6","last_updated_at":${updated}}}`, receipt, now)).toThrowError(expect.objectContaining({ code: "shape" }));
    expect(() => parseCoinGeckoObservation(`{"bitcoin":{"usd":1,"last_updated_at":${updated}}}`, receipt, now)).toThrowError(expect.objectContaining({ code: "shape" }));
    expect(() => parseCoinGeckoObservation(rawBody("-100"), receipt, now)).toThrowError(expect.objectContaining({ code: "shape" }));
  });

  it("accepts the exact five-minute age boundary but not rounded threshold equality", () => {
    const receipt = new Date("2026-11-15T03:59:30Z");
    const boundary = Math.floor(now.getTime() / 1000) - 300;
    expect(parseCoinGeckoObservation(rawBody("-5", boundary), receipt, now).change).toBe("-5");
    expect(priceZone("-5")).toBe("neutral");
  });
});
