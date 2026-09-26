# ParkBuddy

Phone app for registering visitor parking on the parkon portal: save your visitors once, book in a few taps, and stays longer than 8 hours are re-registered automatically.

## How it works

```
Phone (PWA on GitHub Pages)            Cloudflare Worker                    parkon portal
 visitors + settings in localStorage → REST API (/bookings)
 export / import JSON backup           D1: bookings + 8h slots
                                       cron every minute ──────────────────→ fills + submits the form
                                       (Browser Rendering, headless Chromium)   (Blazor Server, no API)
```

- **app/** is a static PWA with no build step. It's published to GitHub Pages by `.github/workflows/pages.yml`.
- **worker/** is the Cloudflare Worker: the API, the scheduler and the portal automation (`src/parkon.js`).
- **poc/** holds local tools: the Playwright booking script, the icon generator and the app smoke test.

The parkon form only offers 2/4/6/8h. Longer stays are split into back-to-back 8h registrations, and a registration always starts at submit time.

## Setup

Worker (needs a Cloudflare account):

```sh
cd worker
npm install
npx wrangler d1 create parkbuddy-db          # put the id into wrangler.toml
npx wrangler d1 migrations apply parkbuddy-db --remote
npx wrangler deploy
npx wrangler secret put ACCESS_KEY           # shared key, also store it in worker/.dev.vars
```

App: enable GitHub Pages with source "GitHub Actions". Users connect with an invite link:
`https://<user>.github.io/parkbuddy/#setup=<base64url of {"u": workerUrl, "k": accessKey}>`.
Once connected, the app can share this link itself (Settings → Share ParkBuddy).

## Test

```sh
cd poc && npm install && npx playwright install chromium
node app-smoke.mjs                           # full app flow against the live Worker, test mode only
node book.mjs SO 12345 2 --dry               # fill the portal form locally without submitting
```

Secrets (`worker/.dev.vars`) and HAR captures are git-ignored.
