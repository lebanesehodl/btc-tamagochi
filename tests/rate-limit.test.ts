import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionRateLimiter } from "../src/server/rate-limit.ts";

afterEach(() => vi.useRealTimers());

describe("anonymous action budgets", () => {
  it("limits session and IP bursts and reports a retry window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const limiter = new ActionRateLimiter();
    for (let i = 0; i < 20; i++) expect(limiter.check("same-session", `ip-${i}`).allowed).toBe(true);
    expect(limiter.check("same-session", "different-ip")).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
    vi.advanceTimersByTime(61_000);
    expect(limiter.check("same-session", "different-ip").allowed).toBe(true);

    const other = new ActionRateLimiter();
    for (let i = 0; i < 60; i++) expect(other.check(`session-${i}`, "one-ip").allowed).toBe(true);
    expect(other.check("new-session", "one-ip").allowed).toBe(false);
  });
});
