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
- `src/state/sessionState.js` exports: `trackMessageId`, `track`, `tipsInProgress`, `reportsInProgress`, `awaitingTeamName`, `awaitingFactCheck`, `awaitingHandoff`, `lastSentNews`, `onboardingPending`, `promiseTracker`, `promiseWizardState`, `seedPromiseTracker`, `checkRateLimit`, `pollData`, `seedKeywordAlerts`, `searchSessions`, `searchHistoryMenu`, `suspensionDetails`, `botMetrics`, `liftSuspension`
- `src/config/constants.js` exports: `CATEGORY_KEYWORDS` (object), `CATEGORY_META` (emoji + label per category)

## Admin routing order (index.js)
1. Opted-out check (all message types)
2. Multi-step user flows (tips, reports, awaitingTeamName, awaitingFactCheck, awaitingHandoff)
3. Search session check (`awaiting_keyword`) — runs BEFORE admin check; if admin has an open search session, commands may be eaten
4. `if (isAdmin(from)) handleAdmin(from, rawText)` — only reached if no user flow matched
5. Non-admin `/command` intercept regex → silent main-menu redirect + probe alert

## broadcast_log status values — CRITICAL
Valid DB CHECK constraint: `pending | sending | sent | failed | cancelled`.  
**'scheduled' is NOT a valid status** — attempting to insert it raises a constraint violation.  
Scheduled broadcasts are stored as `status='pending'` with a non-null `scheduled_at`; the cron job queries `WHERE status='pending' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()`.  
**Why:** the original code had `scheduledAt ? "pending" : "pending"` (dead ternary). Correct fix is just `"pending"`. Do NOT introduce a 'scheduled' status without adding a new migration to alter the constraint AND updating the cron query.

## promise_tracker (migration 006)
Table: `id, politician, promise_text, date_made, status (PENDING/KEPT/BROKEN), created_at, updated_at`.  
Admin wizard: `/promise add` → 4-step interactive flow (name → text → date → status button).  
Admin stats: `/promise stats` → counts + percentages by status + top politicians.  
Seeded from DB on startup via `seedPromiseTracker()` in sessionState.js.  
Button reply IDs: `promise_status_PENDING | promise_status_KEPT | promise_status_BROKEN`.  
Legacy single-command: `ADD PROMISE politician | promise | status` (in-memory only, not DB-backed).

## interactiveHandler.js — admin prefix routing
Must include ALL admin reply prefixes:  
`broadcast_ | admin_ | stats_ | promise_`  
**Add new prefixes here whenever a new admin wizard uses interactive buttons.**

## Migration pattern
Migrations in `migrations/` numbered `001_` → `006_`. Applied in order on every boot by `src/utils/startup.js` (idempotent DDL only). To add a migration: create the file and add its filename to the `MIGRATIONS` array in `startup.js`. All tables use `CREATE TABLE IF NOT EXISTS`.  
Current sequence: 001_initial_schema → 002_add_user_preferences → 003_opt_out → 004_admin_features → 005_search_and_stats → 006_promise_tracker.

## Module B — Search Flow (completed)
- `src/services/searchService.js` — full search module. Exports: `startSearch`, `performSearch`, `handleSearchInteractive`, `runSearchFlow`, `sendSearchHistory`, `getTrendingSearches`, `persistSearchHistory`, `isStopWordsOnly`.
- Session state: `searchSessions` Map (step = `awaiting_keyword` | `results_displayed`), 3-min TTL, `DUPE_CACHE_MS = 2min` to avoid re-running identical keyword.
- Pages of 4 results. Reply IDs: `search_next`, `search_new`, `search_main`, `search_website`, `search_browse`, `search_tryagain`, `search_start`, `search_history_[idx]`, `menu_search`.
- DB tables: `search_history`, `search_analytics` (keyword frequency for /trending).
- Entry points: text triggers ("search", "find", etc.), `/search [kw]`, `/mysearches`, `menu_search` interactive, `nav_search_topic`/`nav_search_news` interactive. All routed through `interactiveHandler.js` prefix guard + `textHandler.js` SEARCH_TRIGGERS block.
- **Why:** search sessions must be checked in `index.js` (step = `awaiting_keyword`) BEFORE admin commands and text handler, otherwise the freetext keyword is misrouted.

## Module C — Admin Stats Dashboard (completed)
- `src/admin/statsService.js` — exports: `buildFullStats`, `buildSecurityDetail`, `buildUsersStats`, `buildHealthStats`, `buildExportStats`, `buildDetailedSubscribers`. Sections: SECURITY & FLAGS, USER METRICS, SEARCH INTELLIGENCE, BROADCAST HISTORY, BOT HEALTH, PROMISE TRACKER.
- `src/admin/securityLog.js` — exports: `logSecurityEvent`, `recordSuspension`, `liftSuspensionByHash`, `getSuspensionDetailsList`. Uses `suspensionDetails` Map from sessionState.
- `src/jobs/healthMetricsJob.js` — `startHealthMetricsJob()` → cron `*/5 * * * *` snapshots botMetrics + session counts into `health_metrics` DB table.
- `/stats [section]` — section can be empty (full), `security`, `users`, `health`, `export`. Message split at 4000 chars if needed.
- `/unsuspend [hash]` — calls `liftSuspensionByHash(hash)` then `liftSuspension(phone)` from sessionState.
- `/trending` — calls `getTrendingSearches(7, 10)` from searchService.
- DB tables: `security_events`, `health_metrics` (alongside B's `search_history`, `search_analytics`) — all in `migrations/005_search_and_stats.sql`.

## Enhanced Admin Menu (completed)
- `sendAdminMenu` replaced with interactive grouped list (`sendList`). Groups: Broadcast & Alerts, Data & Tracking, Intelligence & Security.
- Reply IDs: `admin_cmd_broadcast`, `admin_cmd_breaking`, `admin_cmd_promise`, `admin_cmd_subscribers`, `admin_cmd_trending`, `admin_cmd_stats`, `admin_cmd_unsuspend`.
- `handleAdminInteractive` handles all `admin_cmd_*`, `stats_*`, `admin_subscribers_detail` replies.
- `interactiveHandler.js` guard extended: `stats_` prefix now also routes to admin handler.

## /subscribers enhanced (completed)
- Quick overview queries DB for 6 live metrics (total, active_7d, active_30d, opted_out, new_today, new_week).
- Buttons: Detailed Report (`admin_subscribers_detail`), Full Stats, Admin Menu.
- `handleSubscribersDetailed` calls `buildDetailedSubscribers()` from statsService.

## AI fallback tracking (completed)
- `textHandler.js` AI fallback wraps `getAIResponse` in try/catch: success → `botMetrics.grokSuccessToday++`, failure → `botMetrics.grokFailuresToday++`. Response time pushed to `botMetrics.responseTimes` (rolling 100).

## Security event logging (completed)
- `index.js`: harmful content → `recordSuspension(from, "harmful", snippet)`. Prompt injection → `logSecurityEvent(from, "injection", ...)`. Impersonation → `logSecurityEvent(from, "impersonation", ...)`. All fire-and-forget (`.catch(() => {})`).
- Non-admin command interception regex extended: `/(admin|broadcast|breaking|promise|subscribers|stats|unsuspend|trending)/i`.
- Duplicate dedup now increments `botMetrics.duplicatesBlockedToday`.

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
- Health Metrics Snapshot: every 5 min — `startHealthMetricsJob()` in `index.js` start()
- Scheduled Broadcast: `startScheduledBroadcastJob()` — dispatches queued broadcasts + resumes interrupted ones on boot

**Why:** node-cron `timezone: "Africa/Lagos"` treats the expression as local WAT time. "0 19 * * *" fires at 19:00 WAT = 18:00 UTC.

## Section 4 — Tone and Language Policy (completed)
All user-facing strings across the entire codebase must conform to:
- Formal, professional British-influenced English — no pidgin, slang, emojis, or casual punctuation
- PROMPT_EN is the authoritative system prompt. PROMPT_PIDGIN is an alias of PROMPT_EN (pidgin is disallowed per policy).
- `resolveSystemPrompt(userRow)` in `aiService.js` handles language variants: appends `PROMPT_IGBO_ADDENDUM` for `lang="ig"` and `PROMPT_YORUBA_ADDENDUM` for `lang="yo"`. All other langs → English.

## Section 5 — Language Enforcement (completed)
- `src/utils/language.js` — `sanitiseLanguage(text)` post-processes all outgoing text: replaces common pidgin/slang phrases with formal equivalents via a regex map.
- Applied in `whatsappService.js` `sendText` (all outgoing messages) and explicitly in `aiService.js` on Groq completions.

## Section 6 — Website Referral Architecture (completed)
- `src/utils/referral.js` — `tickReferral(userId)` → true every 3rd call per user; `getWebsiteReferral(context)` → context-aware sentence; `appendReferralIfDue(userId, text, context)` → appends referral if 3rd tick.

## Section 7 — Edge Case & Resilience (completed)
- **Opt-out**: migration `003_opt_out.sql`. `index.js` handles "stop"/"unsubscribe"/"opt out" → mark + DB update; "start"/"hi" from opted-out user → clear + re-onboard.
- **Group filtering**: `from.includes("@g.us")` check — only responds to trigger keywords.
- **Message splitting**: `whatsappService.js` `sendText` splits at 3500 chars with `(1/2 — continued below)` / `(2/2)` markers.
- **Unknown button fallback**: `interactiveHandler.js` falls through to `sendMainMenu(from, userRow)` for any unrecognised `replyId`.
