/* Tests for the token destination setup.js writes to.
 *
 * setup.js is a CLI, so these drive it as one: the destination is resolved
 * and validated before the OAuth flow begins, and it is printed in the
 * startup banner, so spawning the script is enough to observe it without
 * ever contacting WHOOP.
 *
 * Run with: npm test  (node --test)
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MODULE_DIR = path.resolve(__dirname, "..");
const SETUP = path.join(MODULE_DIR, "setup.js");

// Fake, and never sent anywhere: the script exits or blocks on the local
// callback long before these would be used.
const FAKE_CREDS = ["--client-id", "test-id", "--client-secret", "test-secret"];

// setup.js shells out to xdg-open once it is listening. Emptying PATH makes
// that lookup fail harmlessly (the script already handles it) instead of
// opening a real browser on whoever runs the suite. node itself is invoked
// by absolute path, so it needs no PATH of its own.
function spawnSetup(args) {
  return spawn(process.execPath, [SETUP, ...args], {
    cwd: MODULE_DIR,
    env: { ...process.env, PATH: "", BROWSER: "", DISPLAY: "" },
  });
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mmm-whoop-setup-"));
}

// Runs setup.js to completion, for the arguments that make it exit early.
function runToExit(args) {
  return new Promise((resolve, reject) => {
    const child = spawnSetup(args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("setup.js did not exit; it should not have started"));
    }, 10000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// Starts setup.js, waits for the startup banner, reads the destination it
// reports, then stops it. Port 0 keeps concurrent runs off a fixed port.
function readBannerTokenPath(args) {
  return new Promise((resolve, reject) => {
    const child = spawnSetup([...args, "--port", "0"]);
    let stdout = "";
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(reject, new Error("no startup banner; got: " + stdout)),
      10000
    );

    child.stdout.on("data", (d) => {
      stdout += d;
      const match = stdout.match(/^\s*Tokens:\s+(.+?)\s*$/m);
      if (match) finish(resolve, match[1]);
    });
    child.on("error", (err) => finish(reject, err));
    child.on("close", () =>
      finish(reject, new Error("setup.js exited early; output: " + stdout))
    );
  });
}

test("--token-path writes to the absolute path given, not the module dir", async () => {
  const tmp = makeTmpDir();
  try {
    const dest = path.join(tmp, "whoop_tokens_frank.json");
    assert.equal(await readBannerTokenPath([...FAKE_CREDS, "--token-path", dest]), dest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("without --token-path the module-directory default is unchanged", async () => {
  const reported = await readBannerTokenPath([...FAKE_CREDS, "--user-id", "alice"]);
  assert.equal(reported, path.resolve(MODULE_DIR, "whoop_tokens_alice.json"));
});

test("a relative --token-path is rejected before the OAuth flow starts", async () => {
  const { code, stderr } = await runToExit([
    ...FAKE_CREDS,
    "--token-path",
    "tokens/whoop.json",
  ]);
  assert.equal(code, 1);
  assert.match(stderr, /--token-path must be an absolute filesystem path/);
});

test("an unwritable destination directory is rejected before the OAuth flow", async () => {
  // Exchanging an authorization code is a one-shot operation, so this has to
  // fail up front rather than after the user has authorized in the browser.
  const tmp = makeTmpDir();
  try {
    const dest = path.join(tmp, "does-not-exist", "whoop.json");
    const { code, stderr } = await runToExit([...FAKE_CREDS, "--token-path", dest]);
    assert.equal(code, 1);
    assert.match(stderr, /cannot write tokens to/);
    assert.match(stderr, /ENOENT/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("an empty --token-path falls back to the default, like tokenPath: \"\"", async () => {
  const reported = await readBannerTokenPath([...FAKE_CREDS, "--user-id", "bob", "--token-path", ""]);
  assert.equal(reported, path.resolve(MODULE_DIR, "whoop_tokens_bob.json"));
});
