import { describe, expect, it, vi } from "vitest";
import { checkRateLimit, getClientIp } from "./rate-limit";

describe("checkRateLimit", () => {
  it("allows requests up to the limit, then blocks with a retry hint", () => {
    const key = "test:blocks-after-limit";

    expect(checkRateLimit(key, 2, 60_000).allowed).toBe(true);
    expect(checkRateLimit(key, 2, 60_000).allowed).toBe(true);

    const blocked = checkRateLimit(key, 2, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("starts a fresh window once the previous one expires", () => {
    vi.useFakeTimers();
    try {
      const key = "test:window-resets";
      checkRateLimit(key, 1, 1_000);
      expect(checkRateLimit(key, 1, 1_000).allowed).toBe(false);

      vi.advanceTimersByTime(1_001);

      expect(checkRateLimit(key, 1, 1_000).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getClientIp", () => {
  it("uses the first x-forwarded-for entry", () => {
    const req = new Request("http://test", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(getClientIp(req)).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip, then to 'unknown'", () => {
    const withRealIp = new Request("http://test", {
      headers: { "x-real-ip": "203.0.113.8" },
    });
    expect(getClientIp(withRealIp)).toBe("203.0.113.8");
    expect(getClientIp(new Request("http://test"))).toBe("unknown");
  });
});
