/* Tests for atomic token persistence (lib/token-store.js).
 * Run with: npm test  (node --test)
 *
 * No real OAuth credentials are used anywhere in this file, and no test
 * prints token contents.
 */

const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { writeFileAtomicSync, saveTokensSync, TOKEN_FILE_MODE } = require("../lib/token-store.js");

const POSIX = process.platform !== "win32";

const FAKE_TOKENS = {
  access_token: "fake-access",
  refresh_token: "fake-refresh",
  expires_in: 3600,
  scope: "offline",
  refreshed_at: "2024-01-01T00:00:00.000Z",
};

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mmm-whoop-atomic-"));
}

// Anything in the destination directory that is not the token file itself.
function strayFiles(dir, tokenFile) {
  return fs.readdirSync(dir).filter((name) => name !== path.basename(tokenFile));
}

function withTmpDir(fn) {
  const dir = makeTmpDir();
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function captureWarnings() {
  const warnings = [];
  mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  return warnings;
}

function errorWithCode(code) {
  const err = new Error(`simulated ${code}`);
  err.code = code;
  return err;
}

// Make the parent-directory fsync (the second fsync of a save) fail with the
// given error, leaving the temp-file fsync alone.
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

test.afterEach(() => {
  mock.restoreAll();
});

/* ------------------------------------------------------------------
 * Basic persistence: the token file keeps the format it always had.
 * ------------------------------------------------------------------ */

test("saveTokensSync writes valid JSON with the expected contents", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");
    saveTokensSync(tokenFile, FAKE_TOKENS);

    const raw = fs.readFileSync(tokenFile, "utf8");
    assert.deepEqual(JSON.parse(raw), FAKE_TOKENS);
    // Same pretty-printed shape the module has always written.
    assert.equal(raw, JSON.stringify(FAKE_TOKENS, null, 2));
  });
});

test("the refresh_uncertain / reauth_required flags round-trip unchanged", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");

    saveTokensSync(tokenFile, { ...FAKE_TOKENS, refresh_uncertain: true });
    assert.equal(JSON.parse(fs.readFileSync(tokenFile, "utf8")).refresh_uncertain, true);

    saveTokensSync(tokenFile, { ...FAKE_TOKENS, reauth_required: true });
    const saved = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.equal(saved.reauth_required, true);
    assert.ok(!saved.refresh_uncertain, "a full replacement clears the previous flag");
  });
});

test("separate users write to separate files without interfering", () => {
  withTmpDir((dir) => {
    const alice = path.join(dir, "whoop_tokens_alice.json");
    const bob = path.join(dir, "whoop_tokens_bob.json");

    saveTokensSync(alice, { ...FAKE_TOKENS, access_token: "alice-access" }, { userId: "alice" });
    saveTokensSync(bob, { ...FAKE_TOKENS, access_token: "bob-access" }, { userId: "bob" });

    assert.equal(JSON.parse(fs.readFileSync(alice, "utf8")).access_token, "alice-access");
    assert.equal(JSON.parse(fs.readFileSync(bob, "utf8")).access_token, "bob-access");
    assert.deepEqual(fs.readdirSync(dir).sort(), [
      "whoop_tokens_alice.json",
      "whoop_tokens_bob.json",
    ]);
  });
});

/* ------------------------------------------------------------------
 * Permissions. The rename creates a new inode, so the replacement's
 * mode is set explicitly rather than inherited from the destination.
 * ------------------------------------------------------------------ */

test("saved token file is owner-only where the platform reports modes", (t) => {
  if (!POSIX) return t.skip("file modes not checkable on this platform");

  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");
    saveTokensSync(tokenFile, FAKE_TOKENS);

    assert.equal(fs.statSync(tokenFile).mode & 0o777, TOKEN_FILE_MODE);
  });
});

test("replacing a world-readable token file does not weaken permissions", (t) => {
  if (!POSIX) return t.skip("file modes not checkable on this platform");

  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");
    fs.writeFileSync(tokenFile, "{}", { mode: 0o644 });
    fs.chmodSync(tokenFile, 0o644);

    saveTokensSync(tokenFile, FAKE_TOKENS);

    assert.equal(
      fs.statSync(tokenFile).mode & 0o777,
      TOKEN_FILE_MODE,
      "a refresh should correct a historically over-permissive token file"
    );
  });
});

test("the replacement is 0600 regardless of a permissive umask", (t) => {
  if (!POSIX) return t.skip("umask handling is POSIX-specific");

  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");
    const prevUmask = process.umask(0o000);
    try {
      saveTokensSync(tokenFile, FAKE_TOKENS);
    } finally {
      process.umask(prevUmask);
    }

    assert.equal(fs.statSync(tokenFile).mode & 0o777, TOKEN_FILE_MODE);
  });
});

/* ------------------------------------------------------------------
 * Atomic-write behavior.
 * ------------------------------------------------------------------ */

test("no temporary file is left behind after a successful save", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");
    saveTokensSync(tokenFile, FAKE_TOKENS);
    saveTokensSync(tokenFile, { ...FAKE_TOKENS, access_token: "second" });

    assert.deepEqual(strayFiles(dir, tokenFile), []);
  });
});

test("a successful atomic save replaces the previous file contents", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");
    saveTokensSync(tokenFile, FAKE_TOKENS);

    const rotated = { ...FAKE_TOKENS, access_token: "rotated", refresh_token: "rotated-refresh" };
    saveTokensSync(tokenFile, rotated);

    assert.deepEqual(JSON.parse(fs.readFileSync(tokenFile, "utf8")), rotated);
  });
});

test("the temporary file is created in the destination directory", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");
    const opened = [];
    const realOpen = fs.openSync;
    mock.method(fs, "openSync", (target, ...rest) => {
      opened.push(String(target));
      return realOpen(target, ...rest);
    });

    saveTokensSync(tokenFile, FAKE_TOKENS);
    mock.restoreAll();

    // First open is the temp file; it must be a sibling of the destination so
    // the rename stays atomic (no cross-filesystem move).
    assert.equal(path.dirname(opened[0]), dir);
    assert.notEqual(opened[0], tokenFile);
  });
});

test("concurrent saves to the same destination pick distinct temp names", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");
    const opened = [];
    const realOpen = fs.openSync;
    mock.method(fs, "openSync", (target, ...rest) => {
      opened.push(String(target));
      return realOpen(target, ...rest);
    });

    saveTokensSync(tokenFile, FAKE_TOKENS);
    saveTokensSync(tokenFile, { ...FAKE_TOKENS, access_token: "second" });
    mock.restoreAll();

    const temps = opened.filter((name) => name.endsWith(".tmp"));
    assert.equal(temps.length, 2);
    assert.notEqual(temps[0], temps[1], "temp names must not collide");
  });
});

test("failure while writing the replacement leaves the existing file intact", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");
    saveTokensSync(tokenFile, FAKE_TOKENS);
    const before = fs.readFileSync(tokenFile);

    mock.method(fs, "writeFileSync", () => {
      throw errorWithCode("ENOSPC");
    });

    assert.throws(() => saveTokensSync(tokenFile, { access_token: "never-written" }), {
      code: "ENOSPC",
    });
    mock.restoreAll();

    assert.deepEqual(fs.readFileSync(tokenFile), before, "byte-for-byte unchanged");
    assert.deepEqual(strayFiles(dir, tokenFile), []);
  });
});

test("failure while fsyncing the replacement leaves the existing file intact", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");
    saveTokensSync(tokenFile, FAKE_TOKENS);
    const before = fs.readFileSync(tokenFile);

    mock.method(fs, "fsyncSync", () => {
      throw errorWithCode("EIO");
    });

    assert.throws(() => saveTokensSync(tokenFile, { access_token: "never-written" }), {
      code: "EIO",
    });
    mock.restoreAll();

    assert.deepEqual(fs.readFileSync(tokenFile), before);
    assert.deepEqual(strayFiles(dir, tokenFile), []);
  });
});

test("rename failure removes the temp file, keeps the destination and rethrows", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");
    saveTokensSync(tokenFile, FAKE_TOKENS);
    const before = fs.readFileSync(tokenFile);

    mock.method(fs, "renameSync", () => {
      throw errorWithCode("EXDEV");
    });

    assert.throws(() => saveTokensSync(tokenFile, { access_token: "never-written" }), {
      code: "EXDEV",
    });
    mock.restoreAll();

    assert.deepEqual(fs.readFileSync(tokenFile), before);
    assert.deepEqual(strayFiles(dir, tokenFile), []);
  });
});

test("a pre-rename failure closes the temp descriptor it opened", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");

    const opened = [];
    const closed = [];
    const realOpen = fs.openSync;
    const realClose = fs.closeSync;
    mock.method(fs, "openSync", (target, ...rest) => {
      const fd = realOpen(target, ...rest);
      opened.push(fd);
      return fd;
    });
    mock.method(fs, "closeSync", (fd) => {
      closed.push(fd);
      return realClose(fd);
    });
    mock.method(fs, "writeFileSync", () => {
      throw errorWithCode("ENOSPC");
    });

    assert.throws(() => saveTokensSync(tokenFile, FAKE_TOKENS), { code: "ENOSPC" });
    mock.restoreAll();

    assert.deepEqual(closed, opened, "every descriptor opened was closed again");
    assert.ok(!fs.existsSync(tokenFile), "the destination was never created");
    assert.deepEqual(fs.readdirSync(dir), [], "the temp file was cleaned up");
  });
});

test("writeFileAtomicSync creates a destination that does not exist yet", () => {
  withTmpDir((dir) => {
    const dest = path.join(dir, "brand-new.json");
    writeFileAtomicSync(dest, "hello");

    assert.equal(fs.readFileSync(dest, "utf8"), "hello");
    assert.deepEqual(strayFiles(dir, dest), []);
  });
});

test("a missing destination directory yields ENOENT and creates nothing", () => {
  withTmpDir((dir) => {
    const missing = path.join(dir, "nope");
    const dest = path.join(missing, "whoop_tokens_alice.json");

    assert.throws(() => writeFileAtomicSync(dest, "{}"), { code: "ENOENT" });
    assert.ok(!fs.existsSync(missing), "no directory is created on the caller's behalf");
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

/* ------------------------------------------------------------------
 * Directory durability. Once the rename has happened the tokens are
 * saved, so a failing directory flush warns but never throws.
 * ------------------------------------------------------------------ */

test("a successful save warns nothing", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");
    const warnings = captureWarnings();

    saveTokensSync(tokenFile, FAKE_TOKENS, { userId: "alice" });
    mock.restoreAll();

    assert.deepEqual(warnings, []);
  });
});

test("directory fsync failure still completes the save and closes the descriptor", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");
    saveTokensSync(tokenFile, FAKE_TOKENS);

    const fsync = failDirectoryFsync(errorWithCode("EIO"));

    const closed = [];
    const realClose = fs.closeSync;
    mock.method(fs, "closeSync", (fd) => {
      closed.push(fd);
      return realClose(fd);
    });
    captureWarnings();

    const rotated = { ...FAKE_TOKENS, access_token: "rotated-despite-dirsync" };
    assert.doesNotThrow(() => saveTokensSync(tokenFile, rotated));
    mock.restoreAll();

    assert.equal(fsync.calls, 2, "directory fsync was attempted");
    assert.equal(closed.length, 2, "temp file and directory descriptors were both closed");
    assert.deepEqual(JSON.parse(fs.readFileSync(tokenFile, "utf8")), rotated);
    assert.deepEqual(strayFiles(dir, tokenFile), []);
  });
});

test("a genuine directory fsync failure warns that durability was not achieved", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");
    failDirectoryFsync(errorWithCode("EIO"));
    const warnings = captureWarnings();

    saveTokensSync(tokenFile, FAKE_TOKENS, { userId: "alice" });
    mock.restoreAll();

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[MMM-Whoop:alice\]/, "the user context is named");
    assert.match(warnings[0], /EIO/);
    assert.match(warnings[0], /replaced/, "says the replacement did happen");
    assert.match(warnings[0], /power loss/, "says durability was not confirmed");
    assert.ok(!warnings[0].includes("fake-refresh"), "never logs token contents");
    // The save itself still succeeded.
    assert.deepEqual(JSON.parse(fs.readFileSync(tokenFile, "utf8")), FAKE_TOKENS);
  });
});

test("without a userId the warning falls back to the bare module tag", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_default.json");
    failDirectoryFsync(errorWithCode("EIO"));
    const warnings = captureWarnings();

    saveTokensSync(tokenFile, FAKE_TOKENS);
    mock.restoreAll();

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\[MMM-Whoop\] /);
  });
});

test("an actionable directory error such as EACCES or EPERM is reported, not swallowed", () => {
  for (const code of ["EACCES", "EPERM", "ENOSPC"]) {
    withTmpDir((dir) => {
      const tokenFile = path.join(dir, "whoop_tokens_alice.json");
      failDirectoryFsync(errorWithCode(code));
      const warnings = captureWarnings();

      saveTokensSync(tokenFile, FAKE_TOKENS, { userId: "alice" });
      mock.restoreAll();

      assert.equal(warnings.length, 1, `${code} should be surfaced`);
      assert.match(warnings[0], new RegExp(code));
    });
  }
});

test("an unknown directory error is still reported", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");
    failDirectoryFsync(new Error("something unexpected"));
    const warnings = captureWarnings();

    saveTokensSync(tokenFile, FAKE_TOKENS, { userId: "alice" });
    mock.restoreAll();

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /something unexpected/);
  });
});

test("a failure to open the directory is reported the same way", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");

    const realOpen = fs.openSync;
    mock.method(fs, "openSync", (target, ...rest) => {
      if (String(target) === dir) throw errorWithCode("EACCES");
      return realOpen(target, ...rest);
    });
    const warnings = captureWarnings();

    assert.doesNotThrow(() => saveTokensSync(tokenFile, FAKE_TOKENS, { userId: "alice" }));
    mock.restoreAll();

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /EACCES/);
    assert.deepEqual(JSON.parse(fs.readFileSync(tokenFile, "utf8")), FAKE_TOKENS);
  });
});

test("a filesystem without directory fsync support warns nothing", () => {
  for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]) {
    withTmpDir((dir) => {
      const tokenFile = path.join(dir, "whoop_tokens_alice.json");
      failDirectoryFsync(errorWithCode(code));
      const warnings = captureWarnings();

      assert.doesNotThrow(() => saveTokensSync(tokenFile, FAKE_TOKENS, { userId: "alice" }));
      mock.restoreAll();

      assert.deepEqual(warnings, [], `${code} should be treated as unsupported, not as a failure`);
      // The save itself still succeeded.
      assert.deepEqual(JSON.parse(fs.readFileSync(tokenFile, "utf8")), FAKE_TOKENS);
      assert.deepEqual(strayFiles(dir, tokenFile), []);
    });
  }
});

test("on Windows the directory fsync is skipped deliberately and silently", () => {
  withTmpDir((dir) => {
    const tokenFile = path.join(dir, "whoop_tokens_alice.json");
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const opened = [];
    const realOpen = fs.openSync;
    mock.method(fs, "openSync", (target, ...rest) => {
      opened.push(String(target));
      return realOpen(target, ...rest);
    });
    const warnings = captureWarnings();

    try {
      saveTokensSync(tokenFile, FAKE_TOKENS, { userId: "alice" });
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
      mock.restoreAll();
    }

    assert.equal(opened.length, 1, "only the temp file is opened; the directory is not");
    assert.deepEqual(warnings, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(tokenFile, "utf8")), FAKE_TOKENS);
    assert.deepEqual(strayFiles(dir, tokenFile), []);
  });
});
