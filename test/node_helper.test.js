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

/* ------------------------------------------------------------------
 * Atomic token persistence, seen from the helper.
 *
 * The storage layer changed; the refresh state machine did not. These
 * tests pin both halves of that: tokens land on disk atomically and
 * owner-only, and a durability warning after a successful replacement
 * never turns a good refresh into an authentication failure.
 * ------------------------------------------------------------------ */

const POSIX = process.platform !== "win32";

function errorWithCode(code) {
  const err = new Error(`simulated ${code}`);
  err.code = code;
  return err;
}

// Fail the parent-directory fsync (the second fsync of a save) only.
function failDirectoryFsync(error) {
  const realFsync = fs.fsyncSync;
  const state = { calls: 0 };
  mock.method(fs, "fsyncSync", (fd) => {
    state.calls += 1;
    if (state.calls > 1) throw error;
    return realFsync(fd);
  });
  return state;
}

function captureWarnings() {
  const warnings = [];
  mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  return warnings;
}

function rotatedResponse() {
  return jsonResponse(200, {
    access_token: "new-access",
    refresh_token: "new-refresh",
    expires_in: 3600,
    scope: "offline",
  });
}

test("saveTokens leaves no temporary file beside the token file", () => {
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  try {
    ctx.tokens.access_token = "rotated";
    helper.saveTokens(ctx);

    assert.equal(onDisk(tokenPath).access_token, "rotated");
    assert.deepEqual(fs.readdirSync(tmp), [path.basename(tokenPath)]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("saveTokens tightens a world-readable token file to owner-only", (t) => {
  if (!POSIX) return t.skip("file modes not checkable on this platform");

  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  try {
    fs.chmodSync(tokenPath, 0o644);

    helper.saveTokens(ctx);

    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a directory-fsync warning does not turn a successful refresh into a failure", async () => {
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  try {
    fetchStub.setHandler(async () => rotatedResponse());
    const fsync = failDirectoryFsync(errorWithCode("EIO"));
    const warnings = captureWarnings();

    const ok = await helper._doRefresh(ctx);
    mock.restoreAll();

    assert.equal(ok, true, "the refresh still reports success");
    assert.equal(fsync.calls, 2, "the directory flush was attempted");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[MMM-Whoop:alice\]/);

    // The replacement really happened, and no auth state moved.
    const saved = onDisk(tokenPath);
    assert.equal(saved.access_token, "new-access");
    assert.equal(saved.refresh_token, "new-refresh");
    assert.ok(!saved.refresh_uncertain, "durability doubt is not token doubt");
    assert.ok(!saved.reauth_required);
    assert.equal(ctx.reauthRequired, false);
    assert.equal(ctx.consecutiveErrors, 0);
    assert.deepEqual(fs.readdirSync(tmp), [path.basename(tokenPath)]);
  } finally {
    mock.restoreAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a save failure before rename keeps the old file and the existing error semantics", async () => {
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  const before = fs.readFileSync(tokenPath);
  try {
    fetchStub.setHandler(async () => rotatedResponse());
    mock.method(fs, "renameSync", () => {
      throw errorWithCode("EIO");
    });

    // As before this change, a failed write is logged and swallowed: it does
    // not throw, and it does not invent a new authentication state.
    const ok = await helper._doRefresh(ctx);
    mock.restoreAll();

    assert.equal(ok, true);
    assert.equal(ctx.tokens.access_token, "new-access", "in-memory tokens still rotate");
    assert.deepEqual(fs.readFileSync(tokenPath), before, "old token file byte-for-byte intact");
    assert.equal(ctx.reauthRequired, false);
    assert.deepEqual(fs.readdirSync(tmp), [path.basename(tokenPath)], "temp file cleaned up");
  } finally {
    mock.restoreAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a save failure while recording refresh_uncertain stays non-terminal", async () => {
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  const before = fs.readFileSync(tokenPath);
  try {
    fetchStub.setHandler(async () => {
      throw new Error("request to https://api.prod.whoop.com/... failed");
    });
    mock.method(fs, "renameSync", () => {
      throw errorWithCode("EIO");
    });

    const ok = await helper._doRefresh(ctx);
    mock.restoreAll();

    assert.equal(ok, false);
    assert.equal(ctx.reauthRequired, false, "a storage failure is not a rejected token");
    assert.equal(ctx.tokens.refresh_uncertain, true, "still recorded in memory");
    assert.deepEqual(fs.readFileSync(tokenPath), before);
    assert.deepEqual(fs.readdirSync(tmp), [path.basename(tokenPath)]);
  } finally {
    mock.restoreAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("one user's failing token persistence does not affect another user", async () => {
  const helper = makeHelper();
  const tmp = makeTmpDir();
  const alicePath = path.join(tmp, "alice.json");
  const bobPath = path.join(tmp, "bob.json");
  fs.writeFileSync(alicePath, JSON.stringify(FAKE_TOKENS));
  fs.writeFileSync(bobPath, JSON.stringify(FAKE_TOKENS));
  const aliceBefore = fs.readFileSync(alicePath);

  try {
    helper.socketNotificationReceived("WHOOP_INIT", baseConfig("alice", { tokenPath: alicePath }));
    helper.socketNotificationReceived("WHOOP_INIT", baseConfig("bob", { tokenPath: bobPath }));
    const alice = helper.users.alice;
    const bob = helper.users.bob;

    fetchStub.setHandler(async () => rotatedResponse());

    // Only alice's destination is unwritable.
    const realRename = fs.renameSync;
    mock.method(fs, "renameSync", (from, to) => {
      if (String(to) === alicePath) throw errorWithCode("EACCES");
      return realRename(from, to);
    });

    assert.equal(await helper._doRefresh(alice), true);
    assert.equal(await helper._doRefresh(bob), true);
    mock.restoreAll();

    assert.deepEqual(fs.readFileSync(alicePath), aliceBefore, "alice's file is untouched");
    assert.equal(onDisk(bobPath).access_token, "new-access", "bob persists normally");
    assert.equal(alice.reauthRequired, false);
    assert.equal(bob.reauthRequired, false);
    assert.notEqual(alice.tokens, bob.tokens, "no shared token state");
    assert.deepEqual(fs.readdirSync(tmp).sort(), ["alice.json", "bob.json"]);
  } finally {
    mock.restoreAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------
 * Per-user refresh locking – unchanged by the storage rework.
 * ------------------------------------------------------------------ */

test("concurrent refreshes for one user share a single in-flight request", async () => {
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  try {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    fetchStub.setHandler(async () => {
      calls += 1;
      await gate;
      return rotatedResponse();
    });

    const first = helper.refreshAccessToken(ctx);
    const second = helper.refreshAccessToken(ctx);
    assert.equal(first, second, "the second caller awaits the same promise");

    release();
    const [a, b] = await Promise.all([first, second]);

    assert.equal(a, true);
    assert.equal(b, true);
    assert.equal(calls, 1, "only one refresh request is issued");
    assert.equal(ctx._refreshPromise, null, "the lock is released afterwards");
    assert.equal(onDisk(tokenPath).refresh_token, "new-refresh");
    assert.deepEqual(fs.readdirSync(tmp), [path.basename(tokenPath)]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the refresh lock is released even when the save fails", async () => {
  const helper = makeHelper();
  const { ctx, tmp } = makeRefreshCtx(helper);
  try {
    fetchStub.setHandler(async () => rotatedResponse());
    mock.method(fs, "renameSync", () => {
      throw errorWithCode("EIO");
    });

    await helper.refreshAccessToken(ctx);
    mock.restoreAll();

    assert.equal(ctx._refreshPromise, null);
  } finally {
    mock.restoreAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh locks are per user, not global", async () => {
  const helper = makeHelper();
  const tmp = makeTmpDir();
  const alicePath = path.join(tmp, "alice.json");
  const bobPath = path.join(tmp, "bob.json");
  fs.writeFileSync(alicePath, JSON.stringify(FAKE_TOKENS));
  fs.writeFileSync(bobPath, JSON.stringify(FAKE_TOKENS));

  try {
    helper.socketNotificationReceived("WHOOP_INIT", baseConfig("alice", { tokenPath: alicePath }));
    helper.socketNotificationReceived("WHOOP_INIT", baseConfig("bob", { tokenPath: bobPath }));
    const alice = helper.users.alice;
    const bob = helper.users.bob;

    let calls = 0;
    fetchStub.setHandler(async () => {
      calls += 1;
      return rotatedResponse();
    });

    const aPromise = helper.refreshAccessToken(alice);
    const bPromise = helper.refreshAccessToken(bob);
    assert.notEqual(aPromise, bPromise, "each user holds its own lock");

    await Promise.all([aPromise, bPromise]);

    assert.equal(calls, 2, "neither user blocks the other");
    assert.equal(onDisk(alicePath).access_token, "new-access");
    assert.equal(onDisk(bobPath).access_token, "new-access");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------
 * Both persistence paths go through the shared atomic writer.
 * ------------------------------------------------------------------ */

test("neither node_helper.js nor setup.js writes the token file directly", () => {
  for (const file of ["node_helper.js", "setup.js"]) {
    const source = fs.readFileSync(path.join(MODULE_DIR, file), "utf8");
    assert.ok(
      source.includes('require("./lib/token-store.js")'),
      `${file} should persist tokens through the shared writer`
    );
    assert.ok(
      !/fs\.writeFileSync\s*\(/.test(source),
      `${file} should have no direct writeFileSync token-save path`
    );
  }
});

/* ------------------------------------------------------------------
 * Transport failures vs. lost responses.
 *
 * WHOOP rotates the refresh token on every successful grant, so a
 * refresh that produced no response at all is very different from one
 * whose response was lost: the first probably never spent the token,
 * the second almost certainly did. Only the first is retried.
 * ------------------------------------------------------------------ */

test("refresh: a request that never reached WHOOP is retried once and can succeed", async () => {
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  try {
    let calls = 0;
    fetchStub.setHandler(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error(
          "request to https://api.prod.whoop.com/oauth/oauth2/token failed, " +
            "reason: socket hang up"
        );
      }
      return jsonResponse(200, {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        scope: "offline",
      });
    });

    assert.equal(await helper._doRefresh(ctx), true);
    assert.equal(calls, 2, "the unanswered request is retried once");

    const saved = onDisk(tokenPath);
    assert.equal(saved.refresh_token, "new-refresh");
    assert.ok(!saved.refresh_uncertain, "a recovered refresh records no doubt");
    assert.ok(!saved.reauth_required);
    assert.equal(ctx.reauthRequired, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh: two unanswered requests fall back to uncertain, not terminal", async () => {
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  try {
    let calls = 0;
    fetchStub.setHandler(async () => {
      calls += 1;
      throw new Error("request to https://api.prod.whoop.com/... failed");
    });

    assert.equal(await helper._doRefresh(ctx), false);
    assert.equal(calls, 2, "retried once, then given up on");
    assert.equal(ctx.reauthRequired, false, "still not terminal");
    assert.equal(onDisk(tokenPath).refresh_uncertain, true);
    assert.equal(onDisk(tokenPath).refresh_token, FAKE_TOKENS.refresh_token);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh: a lost response body is never retried", async () => {
  // The response proves WHOOP handled the grant, so the stored token is
  // almost certainly spent. Sending it again would replay a dead
  // credential and convert recoverable doubt into a certain rejection.
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  try {
    let calls = 0;
    fetchStub.setHandler(async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Invalid response body ...: Premature close");
        },
        text: async () => {
          throw new Error("Invalid response body ...: Premature close");
        },
      };
    });

    assert.equal(await helper._doRefresh(ctx), false);
    assert.equal(calls, 1, "a received response is not re-sent");
    assert.equal(ctx.reauthRequired, false);
    assert.equal(onDisk(tokenPath).refresh_uncertain, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh: a rejection is not retried as though it were a transport failure", async () => {
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  try {
    let calls = 0;
    fetchStub.setHandler(async () => {
      calls += 1;
      return jsonResponse(400, { error: "invalid_request" });
    });

    assert.equal(await helper._doRefresh(ctx), false);
    assert.equal(calls, 1);
    assert.equal(ctx.reauthRequired, true);
    assert.equal(onDisk(tokenPath).reauth_required, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh: the retry stays inside one lock, so concurrent callers still share it", async () => {
  const helper = makeHelper();
  const { ctx, tmp } = makeRefreshCtx(helper);
  try {
    let calls = 0;
    fetchStub.setHandler(async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      return jsonResponse(200, {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        scope: "offline",
      });
    });

    const [a, b] = await Promise.all([
      helper.refreshAccessToken(ctx),
      helper.refreshAccessToken(ctx),
    ]);

    assert.equal(a, true);
    assert.equal(b, true);
    assert.equal(calls, 2, "one refresh, one retry -- not two refreshes");
    assert.equal(ctx._refreshPromise, null, "the lock is released");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------
 * Truncated token responses.
 *
 * WHOOP rotates the refresh token on every grant, so a reply we cannot
 * read takes the replacement with it and costs a re-authorization. The
 * body is therefore read as a stream: a break that leaves complete JSON
 * behind is recovered, and one that does not is reported with enough
 * detail to classify it afterwards.
 * ------------------------------------------------------------------ */

// A response whose body is a real stream, optionally ending in an error
// the way node-fetch surfaces a truncated body.
function streamingResponse(status, chunks, endError, headers) {
  const hdrs = headers || {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const key = name.toLowerCase();
        return Object.prototype.hasOwnProperty.call(hdrs, key) ? hdrs[key] : null;
      },
    },
    body: (async function* () {
      for (const chunk of chunks) yield Buffer.from(chunk);
      if (endError) throw endError;
    })(),
    json: async () => {
      throw new Error("json() must not be used when a body stream is present");
    },
    text: async () => {
      throw new Error("text() must not be used when a body stream is present");
    },
  };
}

const ROTATED = {
  access_token: "new-access",
  refresh_token: "new-refresh",
  expires_in: 3600,
  scope: "offline",
};

test("refresh: a complete body that ends unframed is recovered, not thrown away", async () => {
  // The exact shape seen against live WHOOP: the JSON arrives whole and the
  // stream then dies. Discarding it is what loses the rotated token.
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  try {
    const payload = JSON.stringify(ROTATED);
    fetchStub.setHandler(async () =>
      streamingResponse(200, [payload], new Error("Premature close"), {
        "content-length": String(payload.length + 12),
      })
    );

    assert.equal(await helper._doRefresh(ctx), true);

    const saved = onDisk(tokenPath);
    assert.equal(saved.refresh_token, "new-refresh");
    assert.equal(saved.access_token, "new-access");
    assert.ok(!saved.refresh_uncertain, "a recovered refresh records no doubt");
    assert.ok(!saved.reauth_required);
    assert.equal(ctx.reauthRequired, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh: a genuinely truncated body is still recorded as uncertain", async () => {
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  try {
    const payload = JSON.stringify(ROTATED);
    const half = payload.slice(0, Math.floor(payload.length / 2));
    fetchStub.setHandler(async () =>
      streamingResponse(200, [half], new Error("Premature close"))
    );

    assert.equal(await helper._doRefresh(ctx), false);
    assert.equal(ctx.reauthRequired, false, "still not terminal");
    assert.equal(onDisk(tokenPath).refresh_uncertain, true);
    assert.equal(
      onDisk(tokenPath).refresh_token,
      FAKE_TOKENS.refresh_token,
      "the stored token is left alone"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh: a normally streamed response succeeds with no diagnostic noise", async () => {
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    fetchStub.setHandler(async () =>
      streamingResponse(200, [JSON.stringify(ROTATED)], null, {
        "content-length": String(JSON.stringify(ROTATED).length),
      })
    );

    assert.equal(await helper._doRefresh(ctx), true);
    assert.equal(onDisk(tokenPath).refresh_token, "new-refresh");
    assert.deepEqual(errors, [], "a clean refresh logs no diagnostics");
  } finally {
    console.error = realError;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh: the truncation diagnostic never prints token values", async () => {
  const helper = makeHelper();
  const { ctx, tmp } = makeRefreshCtx(helper);
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const payload = JSON.stringify({
      access_token: "SECRET-ACCESS-VALUE",
      refresh_token: "SECRET-REFRESH-VALUE",
      expires_in: 3600,
    });
    fetchStub.setHandler(async () =>
      streamingResponse(200, [payload.slice(0, payload.length - 3)], new Error("Premature close"))
    );

    await helper._doRefresh(ctx);

    const joined = errors.join("\n");
    assert.match(joined, /Token refresh response problem: status=200/);
    assert.match(joined, /Body as received/);
    assert.match(joined, /<redacted>/);
    assert.ok(!joined.includes("SECRET-ACCESS-VALUE"), "the access token is not logged");
    assert.ok(!joined.includes("SECRET-REFRESH-VALUE"), "the refresh token is not logged");
  } finally {
    console.error = realError;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh: the token request opts out of compression", async () => {
  // A truncated gzip stream is indistinguishable from a half-sent body, so
  // the one request that cannot be replayed asks for identity encoding.
  const helper = makeHelper();
  const { ctx, tmp } = makeRefreshCtx(helper);
  try {
    let seen = null;
    fetchStub.setHandler(async (url, opts) => {
      seen = opts;
      return jsonResponse(200, ROTATED);
    });

    assert.equal(await helper._doRefresh(ctx), true);
    assert.equal(seen.compress, false, "node-fetch is told not to negotiate gzip");
    assert.equal(seen.headers["Accept-Encoding"], "identity");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refresh: a stalled body is bounded, and what arrived is still used", async () => {
  // A half-open socket yields no further chunks and no error. Without a bound
  // the refresh never settles and the scheduler never fires again.
  const helper = makeHelper();
  const { ctx, tokenPath, tmp } = makeRefreshCtx(helper);
  const realSetTimeout = global.setTimeout;
  try {
    const payload = JSON.stringify(ROTATED);
    // Fire the module's timeout immediately instead of waiting 15s.
    global.setTimeout = (fn, ms) =>
      ms === 15000 ? realSetTimeout(fn, 0) : realSetTimeout(fn, ms);

    const stream = new (require("stream").PassThrough)();
    stream.write(payload); // complete JSON, then silence -- never ends

    fetchStub.setHandler(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: stream,
      json: async () => {
        throw new Error("json() must not be used when a body stream is present");
      },
      text: async () => {
        throw new Error("text() must not be used when a body stream is present");
      },
    }));

    assert.equal(await helper._doRefresh(ctx), true, "the stall resolves rather than hanging");
    assert.equal(onDisk(tokenPath).refresh_token, "new-refresh");
  } finally {
    global.setTimeout = realSetTimeout;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
