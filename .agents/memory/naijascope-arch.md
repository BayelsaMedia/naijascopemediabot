---
name: NaijaScope Architecture
description: Key architectural decisions, file layout, and gotchas for the NaijaScope WhatsApp bot
---

## Project root
`naijascopemediabot/` — Node.js ESM (`"type":"module"`), Express 5, Groq SDK, PostgreSQL (pg pool), node-cron.

## Critical exports to preserve
- `src/state/sessionState.js` exports: `trackMessageId`, `track`, `tipsInProgress`, `reportsInProgress`, `awaitingTeamName`, `awaitingFactCheck`, `awaitingHandoff`, `lastSentNews`, `promiseTracker`, `checkRateLimit`, `pollData`, `seedKeywordAlerts`
- `src/config/constants.js` exports: `CATEGORY_KEYWORDS` (object used by preferenceService + textHandler)

## Migration pattern
Migrations live in `migrations/` numbered `001_`, `002_`, etc. They are applied in order on every boot by `src/utils/startup.js`. All DDL must be idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`). New migrations: add filename to the `MIGRATIONS` array in `startup.js`.

## Adaptive menu
`sendMainMenu(to, userRow=null)` — userRow optional. Reorders news section based on `userRow.primary_interest`. All new call sites should pass userRow; existing callers passing null continue to work.

## Correlation IDs
`withCorrelationId(reqId, fn)` from `src/utils/logger.js` wraps the webhook async block. All `logger.*` calls within the block automatically include `[reqId]` in output via AsyncLocalStorage.

## Preference tracking
`src/services/preferenceService.js` — `trackCategoryRead(from, category)` is fire-and-forget (never awaited on critical path). Upserts `user_category_counts` and refreshes `users.primary_interest` to whichever category has highest count.

## "Why this matters" flow
Button ID `action_explainer` in interactiveHandler reads `lastSentNews.get(from)[0].title` and calls `getStoryExplainer(title)` in aiService. `lastSentNews` must be set by news-sending code whenever articles are delivered to a user.

## Evening Wrap-Up
`src/jobs/eveningWrapUp.js` — cron at 19:00 UTC (= 20:00 WAT). Sends AI-generated day summary + top-5 links to `daily_digest` subscribers. Uses idempotency key `${number}_evening_${date}` to prevent duplicates.

**Why:** Node.js `cron.schedule` with `timezone: "Africa/Lagos"` treats the expression as local time. Use UTC hour 19 = WAT 20.
