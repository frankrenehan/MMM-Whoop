#!/usr/bin/env node

/* MMM-Whoop – setup.js
 * One-time OAuth 2.0 setup script
 *
 * Usage:
 *   node setup.js --user-id alice --client-id YOUR_ID --client-secret YOUR_SECRET
 *
 * This script:
 *   1. Starts a temporary local HTTP server on port 3456
 *   2. Opens the WHOOP authorization URL in your browser
 *   3. Captures the authorization code from the redirect
 *   4. Exchanges it for access + refresh tokens
 *   5. Saves tokens to whoop_tokens_{userId}.json
 *
 * You only need to run this once per user. The module will refresh
 * tokens automatically after that.
 *
 * For multiple users, run once per person:
 *   node setup.js --user-id alice --client-id ... --client-secret ...
 *   node setup.js --user-id bob  --client-id ... --client-secret ...
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL, URLSearchParams } = require("url");

const crypto = require("crypto");

// --- Parse CLI arguments ---
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

const USER_ID = getArg("--user-id") || "default";
const CLIENT_ID = getArg("--client-id");
const CLIENT_SECRET = getArg("--client-secret");
const PORT = parseInt(getArg("--port") || "3456", 10);

// Validate USER_ID before using it in a file path
if (!/^[a-zA-Z0-9_-]+$/.test(USER_ID)) {
  console.error(
    "\n  Error: --user-id must contain only letters, numbers, hyphens, and underscores.\n"
  );
  process.exit(1);
}
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const TOKEN_FILE = path.resolve(
  __dirname,
  `whoop_tokens_${USER_ID}.json`
);

const AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

const SCOPES = [
  "offline",
  "read:recovery",
  "read:cycles",
  "read:sleep",
  "read:workout",
].join(" ");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("\n  MMM-Whoop OAuth Setup");
  console.error("  =====================\n");
  console.error(
    "  Usage: node setup.js --user-id USER --client-id YOUR_CLIENT_ID --client-secret YOUR_CLIENT_SECRET\n"
  );
  console.error("  Options:");
  console.error("    --user-id        User identifier (e.g. alice, bob). Default: default");
  console.error("    --client-id      Your WHOOP app Client ID");
  console.error("    --client-secret  Your WHOOP app Client Secret");
  console.error("    --port           Local server port (default: 3456)\n");
  console.error("  Steps:");
  console.error(
    "    1. Go to https://developer-dashboard.whoop.com and create an app"
  );
  console.error(
    "    2. Set the redirect URI to: http://localhost:3456/callback"
  );
  console.error("    3. Copy your Client ID and Client Secret");
  console.error("    4. Run this script with the credentials above\n");
  console.error("  For multiple users, run once per person:");
  console.error(
    "    node setup.js --user-id alice --client-id ... --client-secret ..."
  );
  console.error(
    "    node setup.js --user-id bob  --client-id ... --client-secret ...\n"
  );
  process.exit(1);
}

// --- Build authorization URL ---
const STATE_NONCE = crypto.randomBytes(16).toString("hex");

const authParams = new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: "code",
  scope: SCOPES,
  state: STATE_NONCE,
});

const authorizationUrl = `${AUTH_URL}?${authParams.toString()}`;

// --- Exchange code for tokens ---
async function exchangeCode(code) {
  let fetchFn;
  try {
    fetchFn = require("node-fetch");
  } catch {
    fetchFn = globalThis.fetch;
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    code: code,
  });

  const response = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${errText}`);
  }

  return response.json();
}

// --- HTML escape for safe rendering of dynamic values ---
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Start temporary server ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const returnedState = url.searchParams.get("state");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="font-family:sans-serif;padding:40px;background:#1a1a1a;color:#e04040"><h2>Authorization Failed</h2><p>${escapeHtml(error)}</p></body></html>`
      );
      console.error("\n  Authorization failed:", error);
      process.exit(1);
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(
        '<html><body style="font-family:sans-serif;padding:40px;background:#1a1a1a;color:#f5c542"><h2>No authorization code received</h2></body></html>'
      );
      return;
    }

    if (returnedState !== STATE_NONCE) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(
        '<html><body style="font-family:sans-serif;padding:40px;background:#1a1a1a;color:#e04040"><h2>State Mismatch</h2><p>OAuth state parameter does not match. Possible CSRF attempt.</p></body></html>'
      );
      console.error("\n  State mismatch – expected:", STATE_NONCE, "got:", returnedState);
      return;
    }

    try {
      console.log("\n  Authorization code received. Exchanging for tokens...");
      const tokenData = await exchangeCode(code);

      const tokens = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
        scope: tokenData.scope,
        created_at: new Date().toISOString(),
      };

      fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        '<html><body style="font-family:sans-serif;padding:40px;background:#1a1a1a;color:#1db954">' +
          "<h2>&#10003; MMM-Whoop Authenticated (" +
          USER_ID +
          ")</h2>" +
          "<p>Tokens saved. You can close this window and restart MagicMirror.</p>" +
          "</body></html>"
      );

      console.log("  User:          ", USER_ID);
      console.log("  Tokens saved to:", TOKEN_FILE);
      console.log(
        "  Scopes granted:",
        tokenData.scope || "all requested"
      );
      console.log(
        "\n  Setup complete! Restart MagicMirror to begin displaying data.\n"
      );

      setTimeout(() => {
        server.close();
        process.exit(0);
      }, 1000);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="font-family:sans-serif;padding:40px;background:#1a1a1a;color:#e04040"><h2>Token Exchange Failed</h2><p>${escapeHtml(err.message)}</p></body></html>`
      );
      console.error("\n  Token exchange failed:", err.message);
      process.exit(1);
    }
  } else {
    res.writeHead(302, { Location: authorizationUrl });
    res.end();
  }
});

server.listen(PORT, () => {
  console.log("\n  MMM-Whoop OAuth Setup");
  console.log("  =====================\n");
  console.log("  User:    " + USER_ID);
  console.log("  Port:    " + PORT);
  console.log("  Tokens:  " + TOKEN_FILE);
  console.log("\n  Open this URL in your browser to authorize:\n");
  console.log("  " + authorizationUrl + "\n");
  console.log("  Waiting for authorization...\n");

  const { exec } = require("child_process");
  const openCmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";

  exec(`${openCmd} "${authorizationUrl}"`, (err) => {
    if (err) {
      console.log(
        "  Could not open browser automatically. Please open the URL above manually.\n"
      );
    }
  });
});
