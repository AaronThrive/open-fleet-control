const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createOpenRouterSource } = require("../src/usage-sources/openrouter");

const KEY = "sk-or-v1-TESTKEY-do-not-leak";

/** fetch stub that records calls and returns a canned JSON body. */
function fakeFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { fetchFn, calls };
}

describe("usage-sources/openrouter", () => {
  it("is unavailable without an API key and never calls fetch", async () => {
    const { fetchFn, calls } = fakeFetch({});
    const source = createOpenRouterSource({ fetchFn });
    assert.strictEqual(source.available, false);
    assert.strictEqual(source.reason, "no API key configured");

    const credits = await source.getCredits();
    assert.strictEqual(credits.available, false);
    assert.ok(credits.error.includes("not configured"));
    assert.strictEqual(calls.length, 0);
  });

  it("treats a whitespace-only key as missing", () => {
    const source = createOpenRouterSource({ apiKey: "   " });
    assert.strictEqual(source.available, false);
  });

  describe("getCredits()", () => {
    it("parses the { data: { total_credits, total_usage } } envelope", async () => {
      const { fetchFn, calls } = fakeFetch({ data: { total_credits: 50, total_usage: 12.5 } });
      const source = createOpenRouterSource({ apiKey: KEY, fetchFn });
      const credits = await source.getCredits();

      assert.deepStrictEqual(credits, {
        available: true,
        totalCredits: 50,
        totalUsage: 12.5,
        remaining: 37.5,
      });
      assert.strictEqual(calls[0].url, "https://openrouter.ai/api/v1/credits");
      assert.strictEqual(calls[0].options.headers.Authorization, `Bearer ${KEY}`);
    });

    it("handles a flat payload variation without the data envelope", async () => {
      const { fetchFn } = fakeFetch({ total_credits: 10, total_usage: 4 });
      const credits = await createOpenRouterSource({ apiKey: KEY, fetchFn }).getCredits();
      assert.strictEqual(credits.totalCredits, 10);
      assert.strictEqual(credits.remaining, 6);
    });

    it("returns nulls for unrecognized shapes instead of throwing", async () => {
      const { fetchFn } = fakeFetch({ data: { something: "else" } });
      const credits = await createOpenRouterSource({ apiKey: KEY, fetchFn }).getCredits();
      assert.strictEqual(credits.totalCredits, null);
      assert.strictEqual(credits.remaining, null);
    });
  });

  describe("getKeyInfo()", () => {
    it("normalizes label, usage, limit and rate limit info", async () => {
      const { fetchFn, calls } = fakeFetch({
        data: {
          label: "fleet-dashboard",
          usage: 12.5,
          limit: 100,
          limit_remaining: 87.5,
          is_free_tier: false,
          rate_limit: { requests: 200, interval: "10s" },
        },
      });
      const info = await createOpenRouterSource({ apiKey: KEY, fetchFn }).getKeyInfo();

      assert.deepStrictEqual(info, {
        available: true,
        label: "fleet-dashboard",
        usage: 12.5,
        limit: 100,
        limitRemaining: 87.5,
        isFreeTier: false,
        rateLimit: { requests: 200, interval: "10s" },
      });
      assert.strictEqual(calls[0].url, "https://openrouter.ai/api/v1/auth/key");
    });

    it("tolerates a null limit (unlimited keys)", async () => {
      const { fetchFn } = fakeFetch({ data: { label: "k", usage: 1, limit: null } });
      const info = await createOpenRouterSource({ apiKey: KEY, fetchFn }).getKeyInfo();
      assert.strictEqual(info.limit, null);
      assert.strictEqual(info.rateLimit, null);
    });
  });

  describe("error handling", () => {
    it("maps HTTP errors to { error } without throwing", async () => {
      const { fetchFn } = fakeFetch({}, { status: 401 });
      const credits = await createOpenRouterSource({ apiKey: KEY, fetchFn }).getCredits();
      assert.strictEqual(credits.available, true);
      assert.ok(credits.error.includes("HTTP 401"));
      assert.ok(!credits.error.includes(KEY));
    });

    it("scrubs the API key out of thrown error messages", async () => {
      const fetchFn = async () => {
        throw new Error(`connect failed for Bearer ${KEY} at openrouter.ai`);
      };
      const credits = await createOpenRouterSource({ apiKey: KEY, fetchFn }).getCredits();
      assert.ok(credits.error.includes("[redacted]"));
      assert.ok(!credits.error.includes(KEY));
    });

    it("reports non-JSON bodies as an error", async () => {
      const fetchFn = async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("unexpected token <");
        },
      });
      const credits = await createOpenRouterSource({ apiKey: KEY, fetchFn }).getCredits();
      assert.ok(credits.error.includes("non-JSON"));
    });

    it("maps an AbortError to a timeout message", async () => {
      const fetchFn = async () => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        throw err;
      };
      const credits = await createOpenRouterSource({
        apiKey: KEY,
        fetchFn,
        timeoutMs: 1234,
      }).getCredits();
      assert.ok(credits.error.includes("timed out after 1234ms"));
    });

    it("supports a custom base URL", async () => {
      const { fetchFn, calls } = fakeFetch({ data: {} });
      await createOpenRouterSource({
        apiKey: KEY,
        fetchFn,
        baseUrl: "https://proxy.example.com/",
      }).getCredits();
      assert.strictEqual(calls[0].url, "https://proxy.example.com/api/v1/credits");
    });
  });
});
