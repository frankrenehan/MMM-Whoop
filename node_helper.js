/* MMM-Whoop – node_helper.js
 * Server-side helper for WHOOP API communication
 *
 * Multi-user: each config instance registers a user context keyed
 * by userId. Each user gets their own tokens, scheduler, fetch
 * state, and refresh lock. No shared mutable state between users.
 *
 * Scheduling: single serialized loop per user. Each fetch completes
 * fully before the next is scheduled. No concurrent fetches or
 * token refreshes within a user context. Exponential backoff with
 * jitter on failure.
 *
 * Error policy: optional endpoints (recovery, sleep, workouts)
 * suppress only 404 "not found" responses, which indicate data
 * that doesn't exist yet. All other errors (auth, rate limit,
 * server, network) propagate and trigger the backoff scheduler.
 */

const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const { saveTokensSync } = require("./lib/token-store.js");

const BASE_URL = "https://api.prod.whoop.com/developer";
const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

// Safe characters for userId and tokenFile path components
var SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Shown on the mirror when WHOOP has rejected the refresh token outright.
var REAUTH_MESSAGE = "WHOOP: re-authorization required";

module.exports = NodeHelper.create({
  start: function () {
    console.log("[MMM-Whoop] Node helper started");
    this.users = {};
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "WHOOP_INIT") {
      var userId = payload.userId || "default";

      // Prevent duplicate init for same user
      if (this.users[userId]) {
        console.log("[MMM-Whoop:" + userId + "] Already initialized, skipping");
        return;
      }

      var config = payload;
      if (!this.validateConfig(config, userId)) return;

      // tokenPath (absolute, validated above) takes precedence over the
      // legacy tokenFile filename, which is resolved inside the module dir.
      var tokenPath;
      if (config.tokenPath) {
        tokenPath = config.tokenPath;
      } else {
        var tokenFile = config.tokenFile || ("whoop_tokens_" + userId + ".json");
        tokenPath = path.resolve(__dirname, tokenFile);
      }
      var ctx = {
        userId: userId,
        config: config,
        tokens: null,
        tokenPath: tokenPath,
        nextTimer: null,
        consecutiveErrors: 0,
        fetching: false,
        reauthRequired: false,
        _refreshPromise: null,
      };

      this.users[userId] = ctx;
      this.loadTokens(ctx);

      if (!ctx.tokens) {
        this.sendSocketNotification("WHOOP_ERROR", {
          userId: userId,
          message:
            "No tokens found. Run: node modules/MMM-Whoop/setup.js " +
            "--user-id " + userId + " --client-id YOUR_ID --client-secret YOUR_SECRET",
        });
      } else if (ctx.tokens.reauth_required) {
        // A previous run recorded that WHOOP rejected this refresh token.
        // Rejection is permanent, so don't start the loop just to replay
        // it. setup.js writes a fresh token file without this flag.
        ctx.reauthRequired = true;
        this.logReauthRequired(ctx);
        this.sendSocketNotification("WHOOP_ERROR", {
          userId: userId,
          message: REAUTH_MESSAGE,
          reauthRequired: true,
        });
      } else {
        if (ctx.tokens.refresh_uncertain) {
          console.warn(
            "[MMM-Whoop:" + userId + "] Last refresh outcome was unknown; " +
              "the stored refresh token may already be spent."
          );
        }
        this.runAndScheduleNext(ctx);
      }
    }
  },

  // --- Config validation ---
  // Returns true if config is usable, false if fatally invalid.

  validateConfig: function (config, userId) {
    var tag = "[MMM-Whoop:" + userId + "]";
    var fatal = false;

    // userId: must be a non-empty string of safe characters
    if (typeof userId !== "string" || userId.length === 0) {
      console.error(tag + " userId must be a non-empty string");
      fatal = true;
    } else if (!SAFE_ID_PATTERN.test(userId)) {
      console.error(
        tag + " userId contains invalid characters. " +
          "Use only letters, numbers, hyphens, and underscores."
      );
      fatal = true;
    }

    // clientId / clientSecret: required for token refresh
    if (typeof config.clientId !== "string" || config.clientId.length === 0) {
      console.warn(tag + " clientId is missing. Token refresh will fail.");
    }
    if (typeof config.clientSecret !== "string" || config.clientSecret.length === 0) {
      console.warn(tag + " clientSecret is missing. Token refresh will fail.");
    }

    // updateInterval: number, minimum 60s, default 15min
    if (config.updateInterval !== undefined) {
      if (typeof config.updateInterval !== "number" || isNaN(config.updateInterval)) {
        console.warn(tag + " updateInterval is not a number, using default (15min)");
        config.updateInterval = 15 * 60 * 1000;
      } else if (config.updateInterval < 60000) {
        console.warn(tag + " updateInterval below 60s, clamping to 60s");
        config.updateInterval = 60000;
      }
    }

    // retryDelay: number, minimum 5s, default 30s
    if (config.retryDelay !== undefined) {
      if (typeof config.retryDelay !== "number" || isNaN(config.retryDelay)) {
        console.warn(tag + " retryDelay is not a number, using default (30s)");
        config.retryDelay = 30000;
      } else if (config.retryDelay < 5000) {
        console.warn(tag + " retryDelay below 5s, clamping to 5s");
        config.retryDelay = 5000;
      }
    }

    // maxActivities: positive integer, default 3
    if (config.maxActivities !== undefined) {
      if (
        typeof config.maxActivities !== "number" ||
        isNaN(config.maxActivities) ||
        config.maxActivities < 1 ||
        config.maxActivities !== Math.floor(config.maxActivities)
      ) {
        console.warn(tag + " maxActivities invalid, using default (3)");
        config.maxActivities = 3;
      }
    }

    // tokenPath: if provided, must be an absolute path. Takes precedence
    // over tokenFile. Empty string means "not set".
    if (config.tokenPath !== undefined && config.tokenPath !== "") {
      if (typeof config.tokenPath !== "string" || !path.isAbsolute(config.tokenPath)) {
        console.error(tag + " tokenPath must be an absolute filesystem path.");
        fatal = true;
      }
    }

    // tokenFile: if provided, must be a safe filename
    if (config.tokenFile !== undefined) {
      if (typeof config.tokenFile !== "string" || config.tokenFile.length === 0) {
        console.warn(tag + " tokenFile is empty, using default");
        config.tokenFile = undefined;
      } else if (
        config.tokenFile.indexOf("/") !== -1 ||
        config.tokenFile.indexOf("\\") !== -1 ||
        config.tokenFile.indexOf("..") !== -1
      ) {
        console.error(
          tag + " tokenFile must be a plain filename, not a path. " +
            "Ignoring and using default."
        );
        config.tokenFile = undefined;
      }
    }

    if (fatal) {
      this.sendSocketNotification("WHOOP_ERROR", {
        userId: userId,
        message: "Invalid configuration. Check MagicMirror logs.",
      });
    }

    return !fatal;
  },

  // --- Token management ---

  loadTokens: function (ctx) {
    var tag = "[MMM-Whoop:" + ctx.userId + "]";
    try {
      if (fs.existsSync(ctx.tokenPath)) {
        var raw = fs.readFileSync(ctx.tokenPath, "utf8");
        var parsed = JSON.parse(raw);
        if (!parsed.access_token || !parsed.refresh_token) {
          console.error(
            tag + " Token file is missing access_token or refresh_token. " +
              "Re-run setup.js to re-authenticate."
          );
          ctx.tokens = null;
          return;
        }
        ctx.tokens = parsed;
        console.log(tag + " Tokens loaded from disk");
      }
    } catch (err) {
      console.error(tag + " Error loading tokens:", err.message);
      ctx.tokens = null;
    }
  },

  // Atomic replacement: the token file is never truncated in place, so a
  // power cut can only leave the previous tokens or the new ones behind.
  // Error handling is unchanged -- a failed save is logged, the in-memory
  // tokens stand, and the caller's refresh/backoff semantics are untouched.
  saveTokens: function (ctx) {
    var tag = "[MMM-Whoop:" + ctx.userId + "]";
    try {
      saveTokensSync(ctx.tokenPath, ctx.tokens, { userId: ctx.userId });
      console.log(tag + " Tokens saved to disk");
    } catch (err) {
      console.error(tag + " Error saving tokens:", err.message);
    }
  },

  // Locked refresh per user – ensures only one refresh runs at a
  // time for a given user. Concurrent callers await the same promise.
  refreshAccessToken: function (ctx) {
    if (ctx._refreshPromise) {
      console.log("[MMM-Whoop:" + ctx.userId + "] Refresh already in progress, waiting...");
      return ctx._refreshPromise;
    }

    ctx._refreshPromise = this._doRefresh(ctx).finally(function () {
      ctx._refreshPromise = null;
    });

    return ctx._refreshPromise;
  },

  _doRefresh: async function (ctx) {
    var tag = "[MMM-Whoop:" + ctx.userId + "]";
    if (!ctx.tokens || !ctx.tokens.refresh_token) {
      console.error(tag + " No refresh token available");
      return false;
    }

    var params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ctx.config.clientId,
      client_secret: ctx.config.clientSecret,
      refresh_token: ctx.tokens.refresh_token,
      scope: "offline",
    });

    var response;
    try {
      response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      });
    } catch (err) {
      // No complete HTTP response. The request may or may not have
      // reached WHOOP, so the token we hold may or may not be spent.
      this.markRefreshUncertain(ctx, err.message);
      return false;
    }

    if (!response.ok) {
      var errText = "";
      try {
        errText = await response.text();
      } catch (e) {
        /* body unreadable; the status is enough to classify */
      }
      console.error(tag + " Token refresh failed:", response.status, errText);

      // On a refresh_token grant, 400 and 401 mean WHOOP has rejected
      // the token itself. That never self-heals -- every retry just
      // replays a spent credential -- so stop instead of backing off.
      if (response.status === 400 || response.status === 401) {
        this.markReauthRequired(ctx);
      }
      return false;
    }

    var data;
    try {
      data = await response.json();
    } catch (err) {
      // Headers arrived but the body was truncated or unparseable. WHOOP
      // rotates the refresh token on every successful grant, so it has
      // very likely issued a replacement that we just lost -- which
      // leaves the token on disk already spent.
      this.markRefreshUncertain(ctx, err.message);
      return false;
    }

    if (!data.access_token || !data.refresh_token) {
      // A 2xx without the expected fields is the same hazard: WHOOP may
      // have rotated without us capturing the new token.
      this.markRefreshUncertain(ctx, "response missing access_token/refresh_token");
      return false;
    }

    var wasUncertain = !!ctx.tokens.refresh_uncertain;

    // Replacing the object rather than merging also clears any
    // refresh_uncertain / reauth_required flags carried on disk.
    ctx.tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      scope: data.scope,
      refreshed_at: new Date().toISOString(),
    };
    ctx.reauthRequired = false;
    this.saveTokens(ctx);

    if (wasUncertain) {
      console.log(tag + " Token refreshed successfully (previous outcome was unknown)");
    } else {
      console.log(tag + " Token refreshed successfully");
    }
    return true;
  },

  // A refresh that neither clearly succeeded nor was clearly rejected.
  // Record the uncertainty on disk so that a rejection on the next
  // attempt -- or after a restart -- is reported as "re-auth needed"
  // immediately, instead of looking like a transient fetch failure.
  markRefreshUncertain: function (ctx, detail) {
    var tag = "[MMM-Whoop:" + ctx.userId + "]";
    console.error(tag + " Token refresh error:", detail);
    console.warn(
      tag + " Refresh outcome unknown -- WHOOP may have rotated the token " +
        "without us capturing it. If the next attempt is rejected, re-run setup.js."
    );
    if (ctx.tokens && !ctx.tokens.refresh_uncertain) {
      ctx.tokens.refresh_uncertain = true;
      this.saveTokens(ctx);
    }
  },

  // WHOOP rejected the refresh token outright: terminal until re-auth.
  markReauthRequired: function (ctx) {
    ctx.reauthRequired = true;
    if (ctx.tokens && !ctx.tokens.reauth_required) {
      ctx.tokens.reauth_required = true;
      this.saveTokens(ctx);
    }
    this.logReauthRequired(ctx);
  },

  logReauthRequired: function (ctx) {
    console.error(
      "[MMM-Whoop:" + ctx.userId + "] Refresh token rejected by WHOOP -- " +
        "re-authorization required. Run: node modules/MMM-Whoop/setup.js " +
        "--user-id " + ctx.userId + " --client-id YOUR_ID --client-secret YOUR_SECRET " +
        "then restart MagicMirror."
    );
  },

  // --- API requests ---

  apiGet: async function (ctx, endpoint, params) {
    if (!ctx.tokens || !ctx.tokens.access_token) {
      throw this._apiError(endpoint, 0, "No access token");
    }

    var url = BASE_URL + endpoint;
    if (params) {
      url += "?" + new URLSearchParams(params).toString();
    }

    var response = await fetch(url, {
      headers: {
        Authorization: "Bearer " + ctx.tokens.access_token,
      },
    });

    // 401: try refreshing the token once and retry
    if (response.status === 401) {
      console.log("[MMM-Whoop:" + ctx.userId + "] Access token expired, refreshing...");
      var refreshed = await this.refreshAccessToken(ctx);
      if (!refreshed) {
        throw this._apiError(endpoint, 401, "Token refresh failed");
      }

      response = await fetch(url, {
        headers: {
          Authorization: "Bearer " + ctx.tokens.access_token,
        },
      });
    }

    // 429: rate limited
    if (response.status === 429) {
      var retryAfter = response.headers.get("Retry-After") || "unknown";
      throw this._apiError(
        endpoint,
        429,
        "Rate limited (Retry-After: " + retryAfter + ")"
      );
    }

    // Other errors
    if (!response.ok) {
      var body = "";
      try {
        body = await response.text();
      } catch (e) {
        /* ignore */
      }
      throw this._apiError(endpoint, response.status, body);
    }

    return response.json();
  },

  _apiError: function (endpoint, status, detail) {
    var msg = endpoint + " " + status;
    if (detail) msg += " – " + detail.substring(0, 200);
    var err = new Error(msg);
    err.endpoint = endpoint;
    err.status = status;
    return err;
  },

  // --- Optional endpoint helper ---
  //
  // Wraps an API promise so that only 404 "not found" responses
  // are suppressed (returned as null). All other errors – auth,
  // rate limit, server errors, network – propagate normally and
  // will be caught by fetchAllData's outer try/catch.

  _optional: function (promise, tag, label) {
    return promise.catch(function (err) {
      if (err.status === 404) {
        console.log(tag + " " + label + ": not available (404)");
        return null;
      }
      // Real failure – log accurately and re-throw
      console.error(tag + " " + label + " failed:", err.message);
      throw err;
    });
  },

  // --- Helpers ---

  isScored: function (record) {
    return record && record.score_state === "SCORED" && record.score;
  },

  // --- Scheduling (per-user serialized loop) ---

  runAndScheduleNext: async function (ctx) {
    if (ctx.nextTimer) {
      clearTimeout(ctx.nextTimer);
      ctx.nextTimer = null;
    }

    if (ctx.reauthRequired) return;
    if (ctx.fetching) return;
    ctx.fetching = true;

    try {
      await this.fetchAllData(ctx);
    } finally {
      ctx.fetching = false;
      this.scheduleNext(ctx);
    }
  },

  scheduleNext: function (ctx) {
    if (ctx.nextTimer) clearTimeout(ctx.nextTimer);
    ctx.nextTimer = null;

    // Terminal auth failure: backing off and trying again only replays a
    // credential WHOOP has already rejected. Stay stopped until setup.js
    // writes a fresh token file and MagicMirror restarts.
    if (ctx.reauthRequired) {
      console.error(
        "[MMM-Whoop:" + ctx.userId + "] Fetch loop halted pending re-authorization."
      );
      return;
    }

    var interval = ctx.config.updateInterval || 15 * 60 * 1000;
    var delay;

    if (ctx.consecutiveErrors === 0) {
      delay = interval;
    } else {
      var baseRetry = ctx.config.retryDelay || 30000;
      delay = Math.min(
        baseRetry * Math.pow(2, ctx.consecutiveErrors - 1),
        interval
      );
      var jitter = delay * 0.2 * (Math.random() * 2 - 1);
      delay = Math.round(delay + jitter);
    }

    var tag = "[MMM-Whoop:" + ctx.userId + "]";
    console.log(
      tag + " Next fetch in " +
        Math.round(delay / 1000) +
        "s" +
        (ctx.consecutiveErrors > 0
          ? " (error " + ctx.consecutiveErrors + ")"
          : "")
    );

    var self = this;
    ctx.nextTimer = setTimeout(function () {
      self.runAndScheduleNext(ctx);
    }, delay);
  },

  // --- Data fetching ---

  fetchAllData: async function (ctx) {
    var tag = "[MMM-Whoop:" + ctx.userId + "]";
    var self = this;

    try {
      var cycles = await this.apiGet(ctx, "/v2/cycle", { limit: 2 });

      var currentCycle = null;
      var prevCycle = null;

      if (cycles.records && cycles.records.length > 0) {
        currentCycle = cycles.records[0];
        if (cycles.records.length > 1) {
          prevCycle = cycles.records[1];
        }
      }

      // Parallel fetches for recovery, sleep, and workouts.
      // Each wrapped with _optional: 404 → null, all else propagates.
      var promises = {};

      if (currentCycle) {
        promises.currentRecovery = this._optional(
          this.apiGet(ctx, "/v2/cycle/" + currentCycle.id + "/recovery"),
          tag,
          "Current recovery"
        );
        promises.currentSleep = this._optional(
          this.apiGet(ctx, "/v2/cycle/" + currentCycle.id + "/sleep"),
          tag,
          "Current sleep"
        );
      }

      if (prevCycle) {
        promises.prevRecovery = this._optional(
          this.apiGet(ctx, "/v2/cycle/" + prevCycle.id + "/recovery"),
          tag,
          "Previous recovery"
        );
        promises.prevSleep = this._optional(
          this.apiGet(ctx, "/v2/cycle/" + prevCycle.id + "/sleep"),
          tag,
          "Previous sleep"
        );
      }

      if (ctx.config.showActivities) {
        var workoutStart = currentCycle
          ? currentCycle.start
          : new Date().toISOString();
        promises.workouts = this._optional(
          this.apiGet(ctx, "/v2/activity/workout", {
            limit: ctx.config.maxActivities || 3,
            start: workoutStart,
          }),
          tag,
          "Workouts"
        );
      }

      // Await all in parallel. Using allSettled so that if multiple
      // optional calls fail with non-404 errors, no rejection goes
      // unhandled. We re-throw the first real error after collecting.
      var keys = Object.keys(promises);
      var settled = await Promise.allSettled(
        keys.map(function (k) {
          return promises[k];
        })
      );
      var results = {};
      var firstError = null;
      keys.forEach(function (k, i) {
        if (settled[i].status === "fulfilled") {
          results[k] = settled[i].value;
        } else {
          results[k] = null;
          if (!firstError) firstError = settled[i].reason;
        }
      });
      if (firstError) throw firstError;

      var currentRecovery = this.isScored(results.currentRecovery)
        ? results.currentRecovery
        : null;
      var prevRecovery = this.isScored(results.prevRecovery)
        ? results.prevRecovery
        : null;
      var currentSleep = this.isScored(results.currentSleep)
        ? results.currentSleep
        : null;
      var prevSleep = this.isScored(results.prevSleep)
        ? results.prevSleep
        : null;
      var workouts = results.workouts
        ? (results.workouts.records || []).filter(function (w) {
            return self.isScored(w);
          })
        : [];

      this.sendSocketNotification("WHOOP_DATA", {
        userId: ctx.userId,
        cycle: currentCycle,
        recovery: currentRecovery,
        sleep: currentSleep,
        workouts: workouts,
        prevCycle: prevCycle,
        prevRecovery: prevRecovery,
        prevSleep: prevSleep,
        fetchedAt: new Date().toISOString(),
      });

      ctx.consecutiveErrors = 0;
      console.log(tag + " Data fetched successfully");
    } catch (err) {
      ctx.consecutiveErrors += 1;
      console.error(
        tag + " Fetch error (attempt " + ctx.consecutiveErrors + "):",
        err.message
      );
      this.sendSocketNotification("WHOOP_ERROR", {
        userId: ctx.userId,
        message: ctx.reauthRequired
          ? REAUTH_MESSAGE
          : err.endpoint
            ? err.endpoint + ": " + err.status
            : err.message,
        reauthRequired: ctx.reauthRequired,
      });
    }
  },
});
