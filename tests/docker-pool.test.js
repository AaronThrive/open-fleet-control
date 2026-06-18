/**
 * Unit tests for src/docker-pool.js — the real Docker adapter for the Phase 3
 * spawn controller.  No live Docker daemon required: all tests stub the
 * underlying http.request-compatible requestFn.
 *
 * Verified:
 *   ps()              — builds the right GET URL; parses the container list
 *   start()           — issues POST /containers/<name>/start; handles 204 & 304
 *   stop()            — issues POST /containers/<name>/stop?t=<grace>; 204 & 304
 *   inspect()         — issues GET /containers/<name>/json; returns parsed JSON
 *   subscribeEvents() — opens a streaming GET; parses ndjson; returns unsubscribe
 *   encodeFilters()   — pure helper: serializes filter objects correctly
 *   parseNdjsonChunk()— pure helper: splits lines, skips malformed, handles partial
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("events");
const {
  createDockerPool,
  encodeFilters,
  parseNdjsonChunk,
  DEFAULT_STOP_GRACE_SECONDS,
} = require("../src/docker-pool");

// ---------------------------------------------------------------------------
// Helper: build a fake http.request that returns a canned response.
//
// recordedRequests collects { method, path } for every call.
// responsesByPath is a map of <path-prefix> → { statusCode, body }.
// ---------------------------------------------------------------------------
function makeRequestFn(responsesByPath = {}, recordedRequests = []) {
  return function fakeRequest(opts, callback) {
    recordedRequests.push({ method: opts.method, path: opts.path, opts });

    // Find matching canned response (longest-prefix match).
    let match = null;
    let matchLen = -1;
    for (const [prefix, resp] of Object.entries(responsesByPath)) {
      if (opts.path.startsWith(prefix) && prefix.length > matchLen) {
        match = resp;
        matchLen = prefix.length;
      }
    }

    const { statusCode = 200, body = "[]" } = match || {};

    // Build a fake IncomingMessage-like emitter.
    const res = new EventEmitter();
    res.statusCode = statusCode;

    // Build a fake ClientRequest emitter.
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.end = () => {
      // Fire callback asynchronously (mirrors Node http behaviour).
      process.nextTick(() => {
        callback(res);
        process.nextTick(() => {
          res.emit("data", Buffer.from(body));
          process.nextTick(() => res.emit("end"));
        });
      });
    };
    return req;
  };
}

// ---------------------------------------------------------------------------
// Helper: build a streaming fake for subscribeEvents tests.
//
// Returns { requestFn, sendChunk, sendEnd, sendError, capturedReq }.
// After createDockerPool is called and subscribeEvents invoked:
//   sendChunk(str) — push a data chunk to the stream
//   sendEnd()      — fire "end" (daemon closed connection)
//   sendError(err) — fire "error" on response
// ---------------------------------------------------------------------------
function makeStreamingRequestFn() {
  let capturedCallback = null;
  let capturedRes = null;
  let capturedReq = null;

  function requestFn(opts, callback) {
    capturedCallback = callback;

    capturedRes = new EventEmitter();
    capturedRes.statusCode = 200;
    capturedRes.resume = () => {};

    capturedReq = new EventEmitter();
    capturedReq.setTimeout = () => {};
    capturedReq.destroy = () => {
      capturedReq.emit("close");
    };
    capturedReq.end = () => {
      process.nextTick(() => capturedCallback(capturedRes));
    };
    return capturedReq;
  }

  return {
    requestFn,
    sendChunk: (str) => capturedRes && capturedRes.emit("data", Buffer.from(str)),
    sendEnd: () => capturedRes && capturedRes.emit("end"),
    sendError: (err) => capturedRes && capturedRes.emit("error", err),
    getReq: () => capturedReq,
  };
}

// ---------------------------------------------------------------------------
// Pure helper tests — no I/O
// ---------------------------------------------------------------------------

describe("encodeFilters()", () => {
  it("encodes a simple label filter to JSON-encoded URL component", () => {
    const result = encodeFilters({ label: ["com.ofc.pool=worker"] });
    const decoded = decodeURIComponent(result);
    assert.deepStrictEqual(JSON.parse(decoded), { label: ["com.ofc.pool=worker"] });
  });

  it("encodes multiple filter keys", () => {
    const result = encodeFilters({ type: ["container"], label: ["com.ofc.pool=worker"] });
    const decoded = decodeURIComponent(result);
    const parsed = JSON.parse(decoded);
    assert.deepStrictEqual(parsed.type, ["container"]);
    assert.deepStrictEqual(parsed.label, ["com.ofc.pool=worker"]);
  });
});

describe("parseNdjsonChunk()", () => {
  it("parses a single complete JSON line", () => {
    const { events, remainder } = parseNdjsonChunk('{"Action":"die"}\n', "");
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].Action, "die");
    assert.strictEqual(remainder, "");
  });

  it("accumulates a partial line as remainder", () => {
    const { events, remainder } = parseNdjsonChunk('{"Action":', "");
    assert.strictEqual(events.length, 0);
    assert.strictEqual(remainder, '{"Action":');
  });

  it("joins remainder from previous chunk with new chunk", () => {
    const { events, remainder } = parseNdjsonChunk('"die"}\n', '{"Action":');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].Action, "die");
    assert.strictEqual(remainder, "");
  });

  it("parses multiple events in one chunk", () => {
    const chunk = '{"Action":"die"}\n{"Action":"oom"}\n';
    const { events } = parseNdjsonChunk(chunk, "");
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].Action, "die");
    assert.strictEqual(events[1].Action, "oom");
  });

  it("skips malformed lines silently", () => {
    const chunk = '{"Action":"die"}\nNOT_JSON\n{"Action":"stop"}\n';
    const { events } = parseNdjsonChunk(chunk, "");
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].Action, "die");
    assert.strictEqual(events[1].Action, "stop");
  });

  it("returns empty events for an empty chunk", () => {
    const { events, remainder } = parseNdjsonChunk("", "");
    assert.strictEqual(events.length, 0);
    assert.strictEqual(remainder, "");
  });
});

// ---------------------------------------------------------------------------
// ps() — GET /v1.41/containers/json?all=true&filters=…
// ---------------------------------------------------------------------------

describe("createDockerPool().ps()", () => {
  it("issues GET to the containers/json endpoint with all=true and label filter", async () => {
    const records = [];
    const containers = [
      { Id: "abc123", Names: ["/worker-1"], State: "exited", Labels: { "com.ofc.pool": "worker" } },
    ];
    const requestFn = makeRequestFn(
      { "/v1.41/containers/json": { statusCode: 200, body: JSON.stringify(containers) } },
      records,
    );
    const pool = createDockerPool({ requestFn });

    const result = await pool.ps({ all: true, filters: { label: ["com.ofc.pool=worker"] } });

    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].method, "GET");
    assert.ok(records[0].path.includes("/v1.41/containers/json"), "path must be containers/json");
    assert.ok(records[0].path.includes("all=true"), "must include all=true");
    assert.ok(
      records[0].path.includes("com.ofc.pool%3Dworker") ||
        records[0].path.includes("com.ofc.pool=worker"),
      "must include pool label filter",
    );

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].Names[0], "/worker-1");
  });

  it("returns an empty array when the daemon returns an empty list", async () => {
    const requestFn = makeRequestFn({ "/v1.41/containers/json": { statusCode: 200, body: "[]" } });
    const pool = createDockerPool({ requestFn });
    const result = await pool.ps({ all: true, filters: { label: ["com.ofc.pool=worker"] } });
    assert.deepStrictEqual(result, []);
  });

  it("throws when the daemon returns an error status", async () => {
    const requestFn = makeRequestFn({
      "/v1.41/containers/json": { statusCode: 500, body: "internal error" },
    });
    const pool = createDockerPool({ requestFn });
    await assert.rejects(() => pool.ps({}), /ps failed.*500/);
  });
});

// ---------------------------------------------------------------------------
// start() — POST /v1.41/containers/<name>/start
// ---------------------------------------------------------------------------

describe("createDockerPool().start()", () => {
  it("issues POST to containers/<name>/start and resolves on 204", async () => {
    const records = [];
    const requestFn = makeRequestFn(
      { "/v1.41/containers/worker-1/start": { statusCode: 204, body: "" } },
      records,
    );
    const pool = createDockerPool({ requestFn });

    await assert.doesNotReject(() => pool.start("worker-1"));

    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].method, "POST");
    assert.ok(records[0].path.includes("/containers/worker-1/start"), "path must include /start");
  });

  it("resolves on 304 (container already running)", async () => {
    const requestFn = makeRequestFn({
      "/v1.41/containers/worker-1/start": { statusCode: 304, body: "" },
    });
    const pool = createDockerPool({ requestFn });
    await assert.doesNotReject(() => pool.start("worker-1"));
  });

  it("throws on 404 (container not found)", async () => {
    const requestFn = makeRequestFn({
      "/v1.41/containers/worker-1/start": { statusCode: 404, body: "not found" },
    });
    const pool = createDockerPool({ requestFn });
    await assert.rejects(() => pool.start("worker-1"), /start.*404/);
  });

  it("throws when name is empty/missing", async () => {
    const pool = createDockerPool({ requestFn: makeRequestFn({}) });
    await assert.rejects(() => pool.start(""), /name is required/);
    await assert.rejects(() => pool.start(null), /name is required/);
  });
});

// ---------------------------------------------------------------------------
// stop() — POST /v1.41/containers/<name>/stop?t=<grace>
// ---------------------------------------------------------------------------

describe("createDockerPool().stop()", () => {
  it("issues POST to containers/<name>/stop with default grace period", async () => {
    const records = [];
    const requestFn = makeRequestFn(
      { "/v1.41/containers/worker-1/stop": { statusCode: 204, body: "" } },
      records,
    );
    const pool = createDockerPool({ requestFn });

    await pool.stop("worker-1", { graceful: true });

    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].method, "POST");
    assert.ok(records[0].path.includes("/containers/worker-1/stop"), "path must include /stop");
    assert.ok(
      records[0].path.includes(`t=${DEFAULT_STOP_GRACE_SECONDS}`),
      `must include t=${DEFAULT_STOP_GRACE_SECONDS}`,
    );
  });

  it("uses t=0 when graceful is false (immediate stop)", async () => {
    const records = [];
    const requestFn = makeRequestFn(
      { "/v1.41/containers/worker-1/stop": { statusCode: 204, body: "" } },
      records,
    );
    const pool = createDockerPool({ requestFn });
    await pool.stop("worker-1", { graceful: false });
    assert.ok(records[0].path.includes("t=0"), "graceful:false must use t=0");
  });

  it("resolves on 304 (container already stopped)", async () => {
    const requestFn = makeRequestFn({
      "/v1.41/containers/worker-1/stop": { statusCode: 304, body: "" },
    });
    const pool = createDockerPool({ requestFn });
    await assert.doesNotReject(() => pool.stop("worker-1", { graceful: true }));
  });

  it("throws when name is empty/missing", async () => {
    const pool = createDockerPool({ requestFn: makeRequestFn({}) });
    await assert.rejects(() => pool.stop(""), /name is required/);
  });
});

// ---------------------------------------------------------------------------
// inspect() — GET /v1.41/containers/<name>/json
// ---------------------------------------------------------------------------

describe("createDockerPool().inspect()", () => {
  const WORKER_MEM = 2684354560; // 2.5 GiB

  it("issues GET to containers/<name>/json and returns parsed object", async () => {
    const records = [];
    const inspectPayload = {
      HostConfig: { Memory: WORKER_MEM, MemorySwap: WORKER_MEM },
      State: { Status: "running", Running: true },
      Config: { Labels: { "com.ofc.pool": "worker" } },
    };
    const requestFn = makeRequestFn(
      {
        "/v1.41/containers/worker-1/json": {
          statusCode: 200,
          body: JSON.stringify(inspectPayload),
        },
      },
      records,
    );
    const pool = createDockerPool({ requestFn });

    const result = await pool.inspect("worker-1");

    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].method, "GET");
    assert.ok(
      records[0].path.includes("/containers/worker-1/json"),
      "path must be containers/<name>/json",
    );
    assert.strictEqual(result.HostConfig.Memory, WORKER_MEM);
    assert.strictEqual(result.HostConfig.MemorySwap, WORKER_MEM);
  });

  it("returns an object with HostConfig.Memory and HostConfig.MemorySwap (controller AC-3 shape)", async () => {
    const inspectPayload = {
      HostConfig: { Memory: WORKER_MEM, MemorySwap: WORKER_MEM },
      State: { Status: "running" },
      Config: { Labels: {} },
    };
    const requestFn = makeRequestFn({
      "/v1.41/containers/worker-1/json": { statusCode: 200, body: JSON.stringify(inspectPayload) },
    });
    const pool = createDockerPool({ requestFn });
    const result = await pool.inspect("worker-1");
    assert.ok("HostConfig" in result, "must have HostConfig");
    assert.ok("Memory" in result.HostConfig, "must have HostConfig.Memory");
    assert.ok("MemorySwap" in result.HostConfig, "must have HostConfig.MemorySwap");
  });

  it("throws on 404 (container not found)", async () => {
    const requestFn = makeRequestFn({
      "/v1.41/containers/worker-1/json": { statusCode: 404, body: "not found" },
    });
    const pool = createDockerPool({ requestFn });
    await assert.rejects(() => pool.inspect("worker-1"), /inspect.*404/);
  });

  it("throws when name is empty/missing", async () => {
    const pool = createDockerPool({ requestFn: makeRequestFn({}) });
    await assert.rejects(() => pool.inspect(""), /name is required/);
  });
});

// ---------------------------------------------------------------------------
// subscribeEvents() — streaming GET /v1.41/events?filters=…
// ---------------------------------------------------------------------------

describe("createDockerPool().subscribeEvents()", () => {
  it("opens a GET to /v1.41/events with container+pool-label filters", (_, done) => {
    const streaming = makeStreamingRequestFn();
    const pool = createDockerPool({ requestFn: streaming.requestFn });

    let requestPath = null;
    // Wrap to capture path before delegating.
    const capturingFn = (opts, cb) => {
      requestPath = opts.path;
      return streaming.requestFn(opts, cb);
    };

    const pool2 = createDockerPool({ requestFn: capturingFn });
    const unsub = pool2.subscribeEvents(() => {});

    setTimeout(() => {
      assert.ok(requestPath, "must have made a request");
      assert.ok(requestPath.includes("/v1.41/events"), "must use /events endpoint");
      assert.ok(
        requestPath.includes("container") && requestPath.includes("com.ofc.pool"),
        "must filter by type=container and pool label",
      );
      unsub();
      done();
    }, 50);
  });

  it("invokes handler with parsed event objects from ndjson stream", (_, done) => {
    const streaming = makeStreamingRequestFn();
    const pool = createDockerPool({ requestFn: streaming.requestFn });

    const received = [];
    const unsub = pool.subscribeEvents((evt) => received.push(evt));

    // Wait for connection, then send events.
    setTimeout(() => {
      streaming.sendChunk('{"Action":"die","Actor":{"Attributes":{"name":"worker-1"}}}\n');
      streaming.sendChunk('{"Action":"oom","Actor":{"Attributes":{"name":"worker-2"}}}\n');

      setTimeout(() => {
        assert.strictEqual(received.length, 2);
        assert.strictEqual(received[0].Action, "die");
        assert.strictEqual(received[0].Actor.Attributes.name, "worker-1");
        assert.strictEqual(received[1].Action, "oom");
        unsub();
        done();
      }, 50);
    }, 50);
  });

  it("handles events split across multiple chunks (partial ndjson)", (_, done) => {
    const streaming = makeStreamingRequestFn();
    const pool = createDockerPool({ requestFn: streaming.requestFn });

    const received = [];
    const unsub = pool.subscribeEvents((evt) => received.push(evt));

    setTimeout(() => {
      // Send event in two chunks.
      streaming.sendChunk('{"Action":"stop","Actor":{"Attr');
      streaming.sendChunk('ibutes":{"name":"worker-3"}}}\n');

      setTimeout(() => {
        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].Action, "stop");
        unsub();
        done();
      }, 50);
    }, 50);
  });

  it("returns an unsubscribe function that stops further event delivery", (_, done) => {
    const streaming = makeStreamingRequestFn();
    const pool = createDockerPool({ requestFn: streaming.requestFn });

    const received = [];
    const unsub = pool.subscribeEvents((evt) => received.push(evt));

    setTimeout(() => {
      streaming.sendChunk('{"Action":"die"}\n');

      setTimeout(() => {
        assert.strictEqual(received.length, 1);
        unsub(); // unsubscribe

        // Any events after unsubscribe should not reach the handler.
        streaming.sendChunk('{"Action":"oom"}\n');

        setTimeout(() => {
          assert.strictEqual(received.length, 1, "no new events after unsub");
          done();
        }, 30);
      }, 30);
    }, 50);
  });

  it("throws when handler is not a function", () => {
    const pool = createDockerPool({ requestFn: makeRequestFn({}) });
    assert.throws(() => pool.subscribeEvents(null), /handler must be a function/);
    assert.throws(() => pool.subscribeEvents("bad"), /handler must be a function/);
  });

  it("does not propagate handler errors to the stream", (_, done) => {
    const streaming = makeStreamingRequestFn();
    const pool = createDockerPool({ requestFn: streaming.requestFn });

    // Handler that throws — must not crash the stream.
    let callCount = 0;
    const unsub = pool.subscribeEvents((evt) => {
      callCount++;
      throw new Error("handler exploded");
    });

    setTimeout(() => {
      // Should not throw despite the crashing handler.
      assert.doesNotThrow(() => {
        streaming.sendChunk('{"Action":"die"}\n');
        streaming.sendChunk('{"Action":"stop"}\n');
      });

      setTimeout(() => {
        // Both events attempted delivery despite the first throwing.
        assert.strictEqual(callCount, 2);
        unsub();
        done();
      }, 50);
    }, 50);
  });
});

// ---------------------------------------------------------------------------
// Interface contract: verify createDockerPool returns exactly the 5 methods
// the spawn controller expects.
// ---------------------------------------------------------------------------

describe("createDockerPool() — controller interface contract", () => {
  it("exposes ps, start, stop, inspect, subscribeEvents — no more, no less", () => {
    const pool = createDockerPool({ requestFn: makeRequestFn({}) });
    const keys = Object.keys(pool).sort();
    assert.deepStrictEqual(keys, ["inspect", "ps", "start", "stop", "subscribeEvents"]);
  });

  it("all five exposed properties are functions", () => {
    const pool = createDockerPool({ requestFn: makeRequestFn({}) });
    for (const key of ["ps", "start", "stop", "inspect", "subscribeEvents"]) {
      assert.strictEqual(typeof pool[key], "function", `${key} must be a function`);
    }
  });
});
