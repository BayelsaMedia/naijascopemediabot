---
name: NaijaScope Architecture
description: Key architectural decisions, file layout, and gotchas for the NaijaScope WhatsApp bot
---

## Project root
`naijascopemediabot/` — Node.js ESM (`"type":"module"`), Express 5, Groq SDK, PostgreSQL (pg pool), node-cron.

## Critical exports to preserve
- `src/state/sessionState.js` exports: `trackMessageId`, `track`, `tipsInProgress`, `reportsInProgress`, `awaitingTeamName`, `awaitingFactCheck`, `awaitingHandoff`, `lastSentNews`, `onboardingPending`, `promiseTracker`, `checkRateLimit`, `pollData`, `seedKeywordAlerts`
- `src/config/constants.js` exports: `CATEGORY_KEYWORDS` (object), `CATEGORY_META` (emoji + label per category)

## Migration pattern
Migrations in `migrations/` numbered `001_`, `002_`, etc. Applied in order on every boot by `src/utils/startup.js` (idempotent DDL only). To add a migration: create the file and add its filename to the `MIGRATIONS` array in `startup.js`.

## Onboarding flow (new users)
`index.js` detects `!existingUser` → adds to `onboardingPending` Set → calls `sendOnboardingWelcome(from)` in `src/whatsapp/onboarding.js`. User picks an interest via list → `interactiveHandler` handles `onboard_{category}` → calls `completeOnboarding(from, category, userRow)` which saves `primary_interest` to DB and sends first personalised news. If user types text while in `onboardingPending`, they get a gentle redirect.

## Adaptive main menu
`sendMainMenu(to, userRow=null)` reorders news section based on `userRow.primary_interest`. Football/sports → ⚽ first. Oil/environment → 📈 first. Existing callers passing null get default order.

## Story card format (sendNewsItems)
Sends a single formatted text message (not a WhatsApp list widget) so full headlines are visible. Format: category emoji + title + link + relative time ("2h ago"). Followed by `sendAfterNewsMenu` with "Why this matters", "Save This", "More Like This", "Main Menu".

## Post-article text shortcuts
`why` / `context` → `getStoryExplainer(lastSentNews[0].title)`
`save` / `bookmark` → `saveArticle(from, lastSentNews[0])`
Both read from `lastSentNews.get(from)` — requires news to have been delivered first.

## Discover command
`discover` / `explore` → counts RSS items by category → shows themed summary card + buttons for top 3 categories. Category button IDs use `cat_{category}` prefix, handled in `textHandler`.

## Correlation IDs
`withCorrelationId(reqId, fn)` from `src/utils/logger.js` wraps the webhook async block. All `logger.*` calls within the block automatically include `[reqId]` via AsyncLocalStorage.

## Preference tracking
`src/services/preferenceService.js` — `trackCategoryRead(from, category)` is fire-and-forget (`.catch(() => {})`). Key: category must match a key in `CATEGORY_KEYWORDS` (e.g. `"sports"` not `"football"`).

## "Why this matters" flow
Button ID `action_explainer` or text `why` → reads `lastSentNews.get(from)[0].title` → calls `getStoryExplainer(title)` in `aiService.js`. Keyword alerts also advertise "Reply 'why'" — same path.

## Cron jobs
- Daily Briefing: 07:00 WAT — personalised, sorted by `primary_interest`, with category emojis
- Evening Wrap-Up: 20:00 WAT (cron "0 19 * * *" with Africa/Lagos tz) — AI summary + top-5 links to `daily_digest` subscribers
- Breaking News Monitor: every 5 min — seeded with current links on boot to avoid re-alerting old stories

**Why:** node-cron `timezone: "Africa/Lagos"` treats the expression as local WAT time. "0 19 * * *" fires at 19:00 WAT = 18:00 UTC.
