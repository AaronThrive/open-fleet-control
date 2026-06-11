/**
 * Tests for the pure (DOM-free) transcript search helpers used by the
 * sessions view. The module is browser ESM, so it is loaded via dynamic
 * import from node:test.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert");

let splitByQuery;
let messageMatchesQuery;

before(async () => {
  const mod = await import("../public/js/transcript-search.js");
  splitByQuery = mod.splitByQuery;
  messageMatchesQuery = mod.messageMatchesQuery;
});

describe("splitByQuery()", () => {
  it("returns a single non-match segment when the query is empty/absent", () => {
    assert.deepStrictEqual(splitByQuery("hello", ""), [{ text: "hello", match: false }]);
    assert.deepStrictEqual(splitByQuery("hello", null), [{ text: "hello", match: false }]);
  });

  it("splits case-insensitively and marks match segments", () => {
    assert.deepStrictEqual(splitByQuery("Deploy the DEPLOY script", "deploy"), [
      { text: "Deploy", match: true },
      { text: " the ", match: false },
      { text: "DEPLOY", match: true },
      { text: " script", match: false },
    ]);
  });

  it("handles matches at start, end, and adjacent occurrences", () => {
    assert.deepStrictEqual(splitByQuery("abab", "ab"), [
      { text: "ab", match: true },
      { text: "ab", match: true },
    ]);
    assert.deepStrictEqual(splitByQuery("xab", "ab"), [
      { text: "x", match: false },
      { text: "ab", match: true },
    ]);
  });

  it("treats regex metacharacters as literals", () => {
    assert.deepStrictEqual(splitByQuery("a.*b yes a.*b", "a.*b"), [
      { text: "a.*b", match: true },
      { text: " yes ", match: false },
      { text: "a.*b", match: true },
    ]);
    assert.deepStrictEqual(splitByQuery("plain", "a.*b"), [{ text: "plain", match: false }]);
  });

  it("returns no segments for empty text", () => {
    assert.deepStrictEqual(splitByQuery("", "x"), []);
  });
});

describe("messageMatchesQuery()", () => {
  it("matches on text case-insensitively", () => {
    assert.strictEqual(messageMatchesQuery({ text: "Hello World", tools: [] }, "world"), true);
    assert.strictEqual(messageMatchesQuery({ text: "Hello", tools: [] }, "world"), false);
  });

  it("matches on tool names", () => {
    assert.strictEqual(messageMatchesQuery({ text: "", tools: ["Bash", "Read"] }, "bash"), true);
  });

  it("never matches an empty query and tolerates malformed messages", () => {
    assert.strictEqual(messageMatchesQuery({ text: "x", tools: [] }, ""), false);
    assert.strictEqual(messageMatchesQuery(null, "x"), false);
    assert.strictEqual(messageMatchesQuery({}, "x"), false);
  });
});
