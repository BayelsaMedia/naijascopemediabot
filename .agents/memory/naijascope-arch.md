---
name: NaijaScope Architecture
description: Key architectural decisions, file layout, and gotchas for the NaijaScope WhatsApp bot
---

## Two codebases — know which is deployed
- `naijascopemediabot/` — the production codebase: PostgreSQL, multi-handler, node-cron, migrations. This is what `render.yaml` now deploys.
- `artifacts/api-server/index.js` — monolithic in-memory fallback, no DB. Previously deployed on Render; now kept as a backup.
- `render.yaml` at repo root → `rootDir: naijascopemediabot`, `buildCommand: npm install`, `startCommand: node index.js`.
- `naijascopemediabot/.npmrc` → `registry=https://registry.npmjs.org/` (prevents Replit's package firewall from blocking Render builds).

## naijascopemediabot/ project root
Node.js ESM (`"type":"module"`), Express 5, Groq SDK, PostgreSQL (pg pool), node-cron.

## Critical exports to preserve
- `src/state/sessionState.js` exports: `trackMessageId`, `track`, `tipsInProgress`, `reportsInProgress`, `awaitingTeamName`, `awaitingFactCheck`, `awaitingHandoff`, `lastSentNews`, `onboardingPending`, `promiseTracker`, `checkRateLimit`, `pollData`, `seedKeywordAlerts`
- `src/config/constants.js` exports: `CATEGORY_KEYWORDS` (object), `CATEGORY_META` (emoji + label per category)

## Webhook body parsing pattern
`express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })` — stores the raw buffer on `req` for HMAC verification WITHOUT throwing inside the verify callback. The route itself calls `verifyWebhookSignature(req)` which returns `false` on failure, `undefined` when skipped (dev mode), or `true` on success. Never throw inside `express.json`'s verify callback — it causes "headers already sent" errors.

## Bug patterns that silence all users (never repeat)
- Any DB call before the try/catch wrapper in the webhook handler (getOpenTicket, getUser, upsertUser) — if any throws, no user ever gets a reply.
- `verifyWebhookSignature` previously called `res.status(401).json(...)` then `throw` — caused "headers already sent" logs. Fixed by returning `false` and letting the route send the response.

## New user onboarding guard
The `if (!existingUser)` check in `index.js` must come **before** the interactive/media/text routing branches. That way a new user's very first message (of any type) always gets the onboarding welcome, not silently dropped or misrouted.

## DB resilience pattern
```js
let existingUser = null, userRow = null, dbAvailable = true;
try {
  existingUser = await getUser(from);
  userRow = await upsertUser(from);
} catch (err) {
  logger.error("[WEBHOOK] DB error:", err.message);
  dbAvailable = false;
}
// If dbAvailable is false, send a friendly retry notice and return.
```

## Migration pattern
Migrations in `migrations/` numbered `001_`, `002_`, etc. Applied in order on every boot by `src/utils/startup.js` (idempotent DDL only). To add a migration: create the file and add its filename to the `MIGRATIONS` array in `startup.js`. All tables use `CREATE TABLE IF NOT EXISTS`.

## Media handler coverage
`src/handlers/mediaHandler.js` must handle ALL WhatsApp message types: location, image, audio, video, document, sticker, reaction, + a catch-all for unknown types. Missing types = silent no-response to users.

## Onboarding flow (new users)
`index.js` detects `!existingUser` (checked BEFORE routing) → adds to `onboardingPending` Set → calls `sendOnboardingWelcome(from)`. User picks an interest via list → `interactiveHandler` handles `onboard_{category}` → calls `completeOnboarding(from, category, userRow)` which saves `primary_interest` to DB and sends first personalised news. If user types text while in `onboardingPending`, they get a gentle redirect.

## Adaptive main menu
`sendMainMenu(to, userRow=null)` reorders news section based on `userRow.primary_interest`. Football/sports → ⚽ first. Oil/environment → 📈 first. Existing callers passing null get default order.

## Story card format (sendNewsItems)
Sends a single formatted text message (not a WhatsApp list widget) so full headlines are visible. Format: category emoji + title + link + relative time ("2h ago"). Followed by `sendAfterNewsMenu` with "Why this matters", "Save This", "More Like This", "Main Menu".

## Discover command
`discover` / `explore` → counts RSS items by category → shows themed summary card + buttons for top 3 categories. Category button IDs use `cat_{category}` prefix, handled in `textHandler`.

## Correlation IDs
`withCorrelationId(reqId, fn)` from `src/utils/logger.js` wraps the webhook async block. All `logger.*` calls within the block automatically include `[reqId]` via AsyncLocalStorage.

## Preference tracking
`src/services/preferenceService.js` — `trackCategoryRead(from, category)` is fire-and-forget (`.catch(() => {})`). Key: category must match a key in `CATEGORY_KEYWORDS` (e.g. `"sports"` not `"football"`).

## Cron jobs
- Daily Briefing: 07:00 WAT — personalised, sorted by `primary_interest`, with category emojis
- Evening Wrap-Up: 20:00 WAT (cron "0 19 * * *" with Africa/Lagos tz)
- Breaking News Monitor: every 5 min — seeded with current links on boot to avoid re-alerting old stories

**Why:** node-cron `timezone: "Africa/Lagos"` treats the expression as local WAT time. "0 19 * * *" fires at 19:00 WAT = 18:00 UTC.

## Section 4 — Tone and Language Policy (completed)
All user-facing strings across the entire codebase must conform to:
- Formal, professional British-influenced English — no pidgin, slang, emojis, or casual punctuation
- PROMPT_EN is the authoritative system prompt. PROMPT_PIDGIN is an alias of PROMPT_EN (pidgin is disallowed per policy).
- `resolveSystemPrompt(userRow)` in `aiService.js` handles language variants: appends `PROMPT_IGBO_ADDENDUM` for `lang="ig"` and `PROMPT_YORUBA_ADDENDUM` for `lang="yo"`. All other langs → English.
- Files updated in Section 4c: `textHandler.js`, `interactiveHandler.js`, `mediaHandler.js`, `onboarding.js`, `alertService.js`, `dailyBriefing.js`, `eveningWrapUp.js`, `dailyPoll.js`, `index.js`.
