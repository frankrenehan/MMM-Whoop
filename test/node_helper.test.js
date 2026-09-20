/* Tests for tokenPath / tokenFile handling in node_helper.js.
 * Run with: npm test  (node --test)
 */

const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("node:module");

// Resolve MagicMirror's "node_helper" alias to a local stub, and swap
// node-fetch for a stub the tests can drive (node_helper captures the
// reference at require time, so this must happen before it loads).
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "node_helper") {
    return path.join(__dirname, "stubs", "node_helper.js");
  }
  if (request === "node-fetch") {
    return path.join(__dirname, "stubs", "node-fetch.js");
  }
  return origResolveFilename.call(this, request, ...rest);
};

const fetchStub = require("./stubs/node-fetch.js");

const MODULE_DIR = path.resolve(__dirname, "..");
const Helper = require("../node_helper.js");

const FAKE_TOKENS = {
  access_token: "fake-access",
  refresh_token: "fake-refresh",
  expires_in: 3600,
};

// Build a helper with network/scheduling side effects stubbed out.
function makeHelper() {
  const helper = new Helper();
  helper.sent = [];
  helper.sendSocketNotification = (notification, payload) => {
    helper.sent.push({ notification, payload });
  };
  helper.runAndScheduleNext = mock.fn(async () => {});
  helper.start();
  return helper;
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mmm-whoop-test-"));
}

function baseConfig(userId, extra) {
  return Object.assign(
    { userId, clientId: "id", clientSecret: "secret", updateInterval: 900000 },
    extra
  );
}

test.beforeEach(() => {
  mock.method(console, "log", () => {});
  mock.method(console, "warn", () => {});
  mock.method(console, "error", () => {});
});

test.afterEach(() => {
  mock.restoreAll();
  fetchStub.reset();
});

test("default: no tokenPath resolves whoop_tokens_<userId>.json in module dir", () => {
  const helper = makeHelper();
  helper.loadTokens = mock.fn((ctx) => {
    ctx.tokens = { ...FAKE_TOKENS };
  });

  helper.socketNotificationReceived("WHOOP_INIT", baseConfig("alice"));

  const ctx = helper.users.alice;
  assert.ok(ctx);
  assert.equal(ctx.tokenPath, path.resolve(MODULE_DIR, "whoop_tokens_alice.json"));
  assert.equal(helper.runAndScheduleNext.mock.callCount(), 1);
  assert.deepEqual(helper.sent, []);
});

test("default: empty-string tokenPath (module default) behaves like unset", () => {
  const helper = makeHelper();
  helper.loadTokens = mock.fn((ctx) => {
    ctx.tokens = { ...FAKE_TOKENS };
  });

  helper.socketNotificationReceived("WHOOP_INIT", baseConfig("alice", { tokenPath: "" }));

  assert.equal(helper.users.alice.tokenPath, path.resolve(MODULE_DIR, "whoop_tokens_alice.json"));
  assert.equal(helper.runAndScheduleNext.mock.callCount(), 1);
  assert.deepEqual(helper.sent, []);
});

test("legacy tokenFile still resolves a plain filename inside module dir", () => {
  const helper = makeHelper();
  helper.loadTokens = mock.fn((ctx) => {
    ctx.tokens = { ...FAKE_TOKENS };
  });

  helper.socketNotificationReceived(
    "WHOOP_INIT",
    baseConfig("alice", { tokenFile: "custom.json" })
  );

  assert.equal(helper.users.alice.tokenPath, path.resolve(MODULE_DIR, "custom.json"));
  assert.equal(helper.runAndScheduleNext.mock.callCount(), 1);
});

test("legacy tokenFile with path separators is still rejected (falls back to default)", () => {
  const helper = makeHelper();
  helper.loadTokens = mock.fn((ctx) => {
    ctx.tokens = { ...FAKE_TOKENS };
  });

  helper.socketNotificationReceived(
    "WHOOP_INIT",
    baseConfig("alice", { tokenFile: "../escape.json" })
  );

  // Not fatal: existing behavior ignores the bad tokenFile and uses default
  assert.equal(helper.users.alice.tokenPath, path.resolve(MODULE_DIR, "whoop_tokens_alice.json"));
  assert.equal(helper.runAndScheduleNext.mock.callCount(), 1);
  assert.deepEqual(helper.sent, []);
});

test("valid absolute tokenPath is used to load and save tokens", () => {
  const tmp = makeTmpDir();
  const tokenPath = path.join(tmp, "alice.json");
  fs.writeFileSync(tokenPath, JSON.stringify(FAKE_TOKENS));

  try {
    const helper = makeHelper();
    helper.socketNotificationReceived("WHOOP_INIT", baseConfig("alice", { tokenPath }));

    const ctx = helper.users.alice;
    assert.ok(ctx);
    assert.equal(ctx.tokenPath, tokenPath);
    assert.equal(ctx.tokens.access_token, FAKE_TOKENS.access_token);
    assert.equal(helper.runAndScheduleNext.mock.callCount(), 1);
    assert.deepEqual(helper.sent, []);

    // Refreshed tokens are written back to the same custom path
    ctx.tokens.access_token = "rotated";
    helper.saveTokens(ctx);
    const onDisk = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
    assert.equal(onDisk.access_token, "rotated");
    assert.ok(!fs.existsSync(path.join(tmp, "whoop_tokens_alice.json")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("tokenPath takes precedence over tokenFile when both are set", () => {
  const tmp = makeTmpDir();
  const tokenPath = path.join(tmp, "alice.json");
  fs.writeFileSync(tokenPath, JSON.stringify(FAKE_TOKENS));

  try {
    const helper = makeHelper();
    helper.socketNotificationReceived(
      "WHOOP_INIT",
      baseConfig("alice", { tokenPath, tokenFile: "custom.json" })
    );

    assert.equal(helper.users.alice.tokenPath, tokenPath);
    assert.equal(helper.runAndScheduleNext.mock.callCount(), 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("invalid relative tokenPath emits WHOOP_ERROR and aborts that user's init", () => {
  const helper = makeHelper();
  helper.loadTokens = mock.fn();

  helper.socketNotificationReceived(
    "WHOOP_INIT",
    baseConfig("alice", { tokenPath: "relative/alice.json" })
  );

  assert.equal(helper.sent.length, 1);
  assert.equal(helper.sent[0].notification, "WHOOP_ERROR");
  assert.equal(helper.sent[0].payload.userId, "alice");
  assert.equal(helper.users.alice, undefined);
  assert.equal(helper.loadTokens.mock.callCount(), 0);
  assert.equal(helper.runAndScheduleNext.mock.callCount(), 0);
});

test("non-string tokenPath emits WHOOP_ERROR and aborts that user's init", () => {
  const helper = makeHelper();
  helper.loadTokens = mock.fn();

  helper.socketNotificationReceived("WHOOP_INIT", baseConfig("alice", { tokenPath: 42 }));

  assert.equal(helper.sent.length, 1);
  assert.equal(helper.sent[0].notification, "WHOOP_ERROR");
  assert.equal(helper.users.alice, undefined);
  assert.equal(helper.runAndScheduleNext.mock.callCount(), 0);
});

test("invalid tokenPath for one user does not affect another user", () => {
  const helper = makeHelper();
  helper.loadTokens = mock.fn((ctx) => {
    ctx.tokens = { ...FAKE_TOKENS };
  });

  helper.socketNotificationReceived(
    "WHOOP_INIT",
    baseConfig("alice", { tokenPath: "relative/alice.json" })
  );
  helper.socketNotificationReceived("WHOOP_INIT", baseConfig("bob"));

  assert.equal(helper.users.alice, undefined);
  assert.ok(helper.users.bob);
  assert.equal(helper.users.bob.tokenPath, path.resolve(MODULE_DIR, "whoop_tokens_bob.json"));
  assert.equal(helper.runAndScheduleNext.mock.callCount(), 1);
});

/* ------------------------------------------------------------------
 * Refresh-outcome classification.
 *
 * WHOOP rotates the refresh token on every successful grant. If a
 * refresh fails in a way that leaves the outcome unknown (dropped
 * connection, truncated body), the token on disk may already be spent
 * -- so that uncertainty is recorded rather than silently replayed.
 * An outright rejection (400/401) is terminal and stops the loop.
 * ------------------------------------------------------------------ */

// Builds a ctx backed by a real token file, as _doRefresh expects.
function makeRefreshCtx(helper, tokens) {
  const tmp = makeTmpDir();
  const tokenPath = path.join(tmp, "alice.json");
  fs.writeFileSync(tokenPath, JSON.stringify(tokens || FAKE_TOKENS));
  helper.socketNotificationReceived("WHOOP_INIT", baseConfig("alice", { tokenPath }));
  return { ctx: helper.users.alice, tokenPath, tmp };
}

function onDisk(tokenPath) {
  return JSON.parse(fs.readFileSync(tokenPath, "utf8"));
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("refresh: dropped connection is recorded as uncertain, not terminal", async () => {
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  try {
    fetchStub.setHandler(async () => {
      throw new Error("request to https://api.prod.whoop.com/... failed");
    });

    const ok = await helper._doRefresh(ctx);

    assert.equal(ok, false);
    assert.equal(ctx.reauthRequired, false, "a network failure is not terminal");
    assert.equal(onDisk(tokenPath).refresh_uncertain, true);
    // The token itself is untouched -- it may still be valid.
    assert.equal(onDisk(tokenPath).refresh_token, FAKE_TOKENS.refresh_token);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh: truncated response body is recorded as uncertain", async () => {
  // This is the real-world failure: a 200 whose body never arrives, so
  // WHOOP has rotated the token but we never saw the replacement.
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  try {
    fetchStub.setHandler(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Invalid response body ...: Premature close");
      },
      text: async () => {
        throw new Error("Invalid response body ...: Premature close");
      },
    }));

    const ok = await helper._doRefresh(ctx);

    assert.equal(ok, false);
    assert.equal(ctx.reauthRequired, false);
    assert.equal(onDisk(tokenPath).refresh_uncertain, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh: 2xx missing tokens is recorded as uncertain", async () => {
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  try {
    fetchStub.setHandler(async () => jsonResponse(200, { expires_in: 3600 }));

    const ok = await helper._doRefresh(ctx);

    assert.equal(ok, false);
    assert.equal(onDisk(tokenPath).refresh_uncertain, true);
    assert.equal(ctx.tokens.access_token, FAKE_TOKENS.access_token);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh: 400 marks re-auth required and persists it", async () => {
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  try {
    fetchStub.setHandler(async () => jsonResponse(400, { error: "invalid_request" }));

    const ok = await helper._doRefresh(ctx);

    assert.equal(ok, false);
    assert.equal(ctx.reauthRequired, true);
    assert.equal(onDisk(tokenPath).reauth_required, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh: 401 marks re-auth required", async () => {
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  try {
    fetchStub.setHandler(async () => jsonResponse(401, { error: "invalid_grant" }));

    assert.equal(await helper._doRefresh(ctx), false);
    assert.equal(ctx.reauthRequired, true);
    assert.equal(onDisk(tokenPath).reauth_required, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh: 5xx is retryable -- neither flag is set", async () => {
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  try {
    fetchStub.setHandler(async () => jsonResponse(503, { error: "unavailable" }));

    assert.equal(await helper._doRefresh(ctx), false);
    assert.equal(ctx.reauthRequired, false);
    assert.ok(!onDisk(tokenPath).reauth_required);
    assert.ok(!onDisk(tokenPath).refresh_uncertain);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh: success stores rotated tokens and clears stale flags", async () => {
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(
    helper,
    { ...FAKE_TOKENS, refresh_uncertain: true }
  );
  try {
    fetchStub.setHandler(async () =>
      jsonResponse(200, {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        scope: "offline",
      })
    );

    assert.equal(await helper._doRefresh(ctx), true);

    const saved = onDisk(tokenPath);
    assert.equal(saved.access_token, "new-access");
    assert.equal(saved.refresh_token, "new-refresh");
    assert.ok(!saved.refresh_uncertain, "uncertainty cleared on success");
    assert.ok(!saved.reauth_required);
    assert.equal(ctx.reauthRequired, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------
 * Terminal state stops the retry loop.
 * ------------------------------------------------------------------ */

test("scheduleNext does not arm a timer once re-auth is required", () => {
  const helper = makeHelper();
  const { ctx, tmp } = makeRefreshCtx(helper);
  try {
    ctx.reauthRequired = true;
    ctx.consecutiveErrors = 3;

    helper.scheduleNext(ctx);

    assert.equal(ctx.nextTimer, null, "no retry should be scheduled");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scheduleNext still arms a timer in the normal case", () => {
  const helper = makeHelper();
  const { ctx, tmp } = makeRefreshCtx(helper);
  try {
    helper.scheduleNext(ctx);

    assert.ok(ctx.nextTimer, "normal operation still schedules");
    clearTimeout(ctx.nextTimer);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("init: persisted reauth_required skips the fetch loop and reports it", () => {
  const tmp = makeTmpDir();
  const tokenPath = path.join(tmp, "alice.json");
  fs.writeFileSync(
    tokenPath,
    JSON.stringify({ ...FAKE_TOKENS, reauth_required: true })
  );

  try {
    const helper = makeHelper();
    helper.socketNotificationReceived("WHOOP_INIT", baseConfig("alice", { tokenPath }));

    assert.equal(helper.users.alice.reauthRequired, true);
    assert.equal(
      helper.runAndScheduleNext.mock.callCount(),
      0,
      "must not replay a token WHOOP already rejected"
    );
    assert.equal(helper.sent.length, 1);
    assert.equal(helper.sent[0].notification, "WHOOP_ERROR");
    assert.equal(helper.sent[0].payload.reauthRequired, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("init: a healthy token file still starts the loop normally", () => {
  const tmp = makeTmpDir();
  const tokenPath = path.join(tmp, "alice.json");
  fs.writeFileSync(tokenPath, JSON.stringify(FAKE_TOKENS));

  try {
    const helper = makeHelper();
    helper.socketNotificationReceived("WHOOP_INIT", baseConfig("alice", { tokenPath }));

    assert.equal(helper.users.alice.reauthRequired, false);
    assert.equal(helper.runAndScheduleNext.mock.callCount(), 1);
    assert.deepEqual(helper.sent, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
