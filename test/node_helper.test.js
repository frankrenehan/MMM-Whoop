/* Tests for tokenPath / tokenFile handling in node_helper.js.
 * Run with: npm test  (node --test)
 */

const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("node:module");

// Resolve MagicMirror's "node_helper" alias to a local stub.
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "node_helper") {
    return path.join(__dirname, "stubs", "node_helper.js");
  }
  return origResolveFilename.call(this, request, ...rest);
};

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
