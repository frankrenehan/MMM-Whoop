# MMM-Whoop

A [MagicMirror²](https://magicmirror.builders/) module that displays your WHOOP health data – recovery score, sleep performance, and day strain – with deltas to the previous day and optional activity details. Supports multiple users on one mirror.

## Features

- **Three headline scores** – Recovery, Sleep Performance, and Day Strain
- **Previous day deltas** – see at a glance if you're trending up or down
- **Color-coded zones** – green/yellow/red for Recovery and Sleep; neutral white for Strain
- **Today's activities** – optional display of workouts with strain, distance, and calories
- **Multi-user support** – multiple WHOOP accounts on one mirror
- **Automatic token refresh** – authenticate once per user, runs indefinitely
- **Serialized scheduling** – no concurrent API calls or token refresh races
- **Stale-data mode** – keeps showing last good data on API errors

## Prerequisites

- A WHOOP device with an active membership (per user)
- A WHOOP Developer account and registered app

## Installation

### 1. Clone the module

```bash
cd ~/MagicMirror/modules
git clone https://github.com/frankrenehan/MMM-Whoop.git
cd MMM-Whoop
npm install
```

### 2. Register a WHOOP Developer App

1. Go to [developer-dashboard.whoop.com](https://developer-dashboard.whoop.com)
2. Sign in with your WHOOP account
3. Create a new app (you'll be prompted to create a Team first)
4. Set the **Redirect URI** to `http://localhost:3456/callback`
5. Select the scopes the module needs: `read:recovery`, `read:cycles`, `read:sleep`, `read:workout`
6. Note your **Client ID** and **Client Secret**

> **Note:** You do not need `read:profile` or `read:body_measurement` – the module does not use them. WHOOP recommends requesting only the scopes your app actually uses.

### 3. Authenticate (one-time per user)

Run the setup script from any machine with a browser:

```bash
node setup.js --user-id alice --client-id YOUR_CLIENT_ID --client-secret YOUR_CLIENT_SECRET
```

This saves tokens to `whoop_tokens_alice.json` in the module directory.

For a second user, have them log in to their WHOOP account and run:

```bash
node setup.js --user-id bob --client-id YOUR_CLIENT_ID --client-secret YOUR_CLIENT_SECRET
```

> **Tip:** You can run this on your laptop and `scp` the token file to the Pi:
> ```bash
> scp whoop_tokens_alice.json pi@YOUR_PI_IP:~/MagicMirror/modules/MMM-Whoop/
> ```

### 4. Configure MagicMirror

**Single user:**

```javascript
{
  module: "MMM-Whoop",
  position: "bottom_left",
  config: {
    userId: "alice",
    clientId: "YOUR_CLIENT_ID",
    clientSecret: "YOUR_CLIENT_SECRET",
  }
},
```

**Two users:**

```javascript
{
  module: "MMM-Whoop",
  position: "bottom_left",
  config: {
    userId: "alice",
    displayName: "ALICE",
    clientId: "YOUR_CLIENT_ID",
    clientSecret: "YOUR_CLIENT_SECRET",
    showActivities: true,
  }
},
{
  module: "MMM-Whoop",
  position: "bottom_left",
  config: {
    userId: "bob",
    displayName: "BOB",
    clientId: "YOUR_CLIENT_ID",
    clientSecret: "YOUR_CLIENT_SECRET",
    showActivities: false,
  }
},
```

Each user instance operates independently – its own tokens, its own polling timer, its own data.

### 5. Restart MagicMirror

```bash
cd ~/MagicMirror
npm start
```

## Configuration Options

| Option | Type | Default | Description |
|---|---|---|---|
| `userId` | `string` | `"default"` | Unique identifier for this user (e.g. `"alice"`, `"bob"`) |
| `displayName` | `string` | `""` | Label shown above scores (e.g. `"ALICE"`). Hidden when empty. |
| `clientId` | `string` | `""` | Your WHOOP app Client ID |
| `clientSecret` | `string` | `""` | Your WHOOP app Client Secret |
| `updateInterval` | `int` | `900000` | Update interval in ms (15 min) |
| `showActivities` | `bool` | `true` | Show today's workouts below scores |
| `maxActivities` | `int` | `3` | Maximum number of activities to display |
| `retryDelay` | `int` | `30000` | Base retry delay on failure in ms (exponential backoff) |
| `animationSpeed` | `int` | `1000` | DOM update animation speed in ms |

## Zone Thresholds

Scores are color-coded to match the WHOOP app:

| Metric | Green | Yellow | Red |
|---|---|---|---|
| Recovery | ≥ 67% | 34–66% | ≤ 33% |
| Sleep | ≥ 90% | 75–89% | < 75% |
| Strain | Neutral (white) – not directionally scored |

## Security

Token files (`whoop_tokens_*.json`) contain your OAuth tokens and are excluded from version control via `.gitignore`. **Never commit these files.**

For additional hardening:

```bash
chmod 600 modules/MMM-Whoop/whoop_tokens_*.json
```

You can supply credentials via environment variables instead of `config.js`:

```bash
export WHOOP_CLIENT_ID="your_client_id"
export WHOOP_CLIENT_SECRET="your_client_secret"
```

Then in `config.js`:

```javascript
clientId: process.env.WHOOP_CLIENT_ID,
clientSecret: process.env.WHOOP_CLIENT_SECRET,
```

## API Endpoints Used

- `GET /v2/cycle` – physiological cycles (day strain)
- `GET /v2/cycle/{id}/recovery` – recovery scores
- `GET /v2/cycle/{id}/sleep` – sleep data
- `GET /v2/activity/workout` – workout activities
- `POST /oauth/oauth2/token` – token refresh

## Troubleshooting

**"No tokens found"** – Run the `setup.js` script for the relevant user.

**"Token refresh failed"** – Your refresh token may have been revoked. Re-run `setup.js` for that user.

**No data showing** – WHOOP data is tied to physiological cycles. If your current cycle hasn't been scored yet (e.g., you haven't slept yet today), some fields will show `--` until data is available.

**Rate limiting** – The default 15-minute interval is well within WHOOP's rate limits for personal use. If you see 429 errors, increase `updateInterval`.

**Multiple users** – Each user needs their own WHOOP account and their own `setup.js` run. They can share the same WHOOP Developer App (same `clientId`/`clientSecret`), but each person authorizes independently.

## License

MIT – see [LICENSE](LICENSE) for details.

## Acknowledgments

- [WHOOP Developer Platform](https://developer.whoop.com/) for the API
- [MagicMirror²](https://magicmirror.builders/) for the platform
