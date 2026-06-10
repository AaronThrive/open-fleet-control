const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createRateLimiter } = require("../src/rate-limit");

// Helper: manual clock so tests are fully deterministic
function makeClock(start = 0) {
  let now = start;
  return {
    nowFn: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

describe("rate-limit module", () => {
  describe("createRateLimiter()", () => {
    it("rejects invalid windowMs", () => {
      assert.throws(() => createRateLimiter({ windowMs: 0 }), /windowMs/);
      assert.throws(() => createRateLimiter({ windowMs: -5 }), /windowMs/);
    });

    it("rejects invalid max", () => {
      assert.throws(() => createRateLimiter({ max: 0 }), /max/);
      assert.throws(() => createRateLimiter({ max: NaN }), /max/);
    });

    it("rejects non-function nowFn", () => {
      assert.throws(() => createRateLimiter({ nowFn: 123 }), /nowFn/);
    });

    it("uses defaults when no options given", () => {
      const limiter = createRateLimiter();
      const result = limiter.check("default-key");
      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.remaining, 119);
    });
  });

  describe("check()", () => {
    it("rejects invalid keys", () => {
      const limiter = createRateLimiter();
      assert.throws(() => limiter.check(""), /key/);
      assert.throws(() => limiter.check(null), /key/);
      assert.throws(() => limiter.check(42), /key/);
    });

    it("allows up to max requests within the window", () => {
      const clock = makeClock();
      const limiter = createRateLimiter({ windowMs: 1000, max: 3, nowFn: clock.nowFn });

      assert.strictEqual(limiter.check("a").allowed, true);
      assert.strictEqual(limiter.check("a").allowed, true);
      assert.strictEqual(limiter.check("a").allowed, true);
      assert.strictEqual(limiter.check("a").allowed, false);
    });

    it("reports decreasing remaining counts", () => {
      const clock = makeClock();
      const limiter = createRateLimiter({ windowMs: 1000, max: 3, nowFn: clock.nowFn });

      assert.strictEqual(limiter.check("a").remaining, 2);
      assert.strictEqual(limiter.check("a").remaining, 1);
      assert.strictEqual(limiter.check("a").remaining, 0);
      assert.strictEqual(limiter.check("a").remaining, 0);
    });

    it("returns retryAfterMs when blocked and 0 when allowed", () => {
      const clock = makeClock();
      const limiter = createRateLimiter({ windowMs: 1000, max: 2, nowFn: clock.nowFn });

      assert.strictEqual(limiter.check("a").retryAfterMs, 0);
      assert.strictEqual(limiter.check("a").retryAfterMs, 0);

      const blocked = limiter.check("a");
      assert.strictEqual(blocked.allowed, false);
      // Refill rate is 2 tokens per 1000ms => 1 token takes 500ms
      assert.strictEqual(blocked.retryAfterMs, 500);
    });

    it("refills tokens gradually as time passes", () => {
      const clock = makeClock();
      const limiter = createRateLimiter({ windowMs: 1000, max: 2, nowFn: clock.nowFn });

      limiter.check("a");
      limiter.check("a");
      assert.strictEqual(limiter.check("a").allowed, false);

      // Half a window refills exactly one token
      clock.advance(500);
      assert.strictEqual(limiter.check("a").allowed, true);
      assert.strictEqual(limiter.check("a").allowed, false);
    });

    it("fully refills after a complete window", () => {
      const clock = makeClock();
      const limiter = createRateLimiter({ windowMs: 1000, max: 3, nowFn: clock.nowFn });

      limiter.check("a");
      limiter.check("a");
      limiter.check("a");
      assert.strictEqual(limiter.check("a").allowed, false);

      clock.advance(1000);
      const refilled = limiter.check("a");
      assert.strictEqual(refilled.allowed, true);
      assert.strictEqual(refilled.remaining, 2); // Full bucket (3) minus this request
    });

    it("never refills beyond max", () => {
      const clock = makeClock();
      const limiter = createRateLimiter({ windowMs: 1000, max: 2, nowFn: clock.nowFn });

      limiter.check("a");
      clock.advance(60000); // Way more than one window
      const result = limiter.check("a");
      assert.strictEqual(result.remaining, 1); // Capped at max (2) minus this request
    });

    it("isolates buckets per key", () => {
      const clock = makeClock();
      const limiter = createRateLimiter({ windowMs: 1000, max: 1, nowFn: clock.nowFn });

      assert.strictEqual(limiter.check("a").allowed, true);
      assert.strictEqual(limiter.check("a").allowed, false);
      // Key "b" has its own full bucket
      assert.strictEqual(limiter.check("b").allowed, true);
      // And "a" is still blocked
      assert.strictEqual(limiter.check("a").allowed, false);
    });
  });

  describe("lazy cleanup", () => {
    it("removes stale keys during later checks", () => {
      const clock = makeClock();
      const limiter = createRateLimiter({ windowMs: 1000, max: 5, nowFn: clock.nowFn });

      limiter.check("stale-1");
      limiter.check("stale-2");
      assert.strictEqual(limiter.size(), 2);

      // Advance beyond 2x window so both keys are stale, then trigger a sweep
      clock.advance(3000);
      limiter.check("fresh");
      assert.strictEqual(limiter.size(), 1);
    });

    it("keeps recently used keys during sweeps", () => {
      const clock = makeClock();
      const limiter = createRateLimiter({ windowMs: 1000, max: 5, nowFn: clock.nowFn });

      limiter.check("old");
      clock.advance(1500);
      limiter.check("young"); // Sweep runs, but "old" is only 1.5 windows stale
      assert.strictEqual(limiter.size(), 2);

      clock.advance(1500);
      limiter.check("young"); // Now "old" is 3 windows stale and gets removed
      assert.strictEqual(limiter.size(), 1);
    });
  });
});
