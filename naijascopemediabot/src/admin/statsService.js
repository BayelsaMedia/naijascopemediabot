/**
 * Module C — Stats Service
 *
 * All database queries and report formatters for the /stats admin dashboard.
 * Each section is independently query-able with a 3-second timeout.
 * Uses DB data + in-memory state from sessionState.botMetrics.
 */

import { query } from "../utils/db.js";
import { logger } from "../utils/logger.js";
import { botMetrics, suspensionDetails, promiseTracker } from "../state/sessionState.js";
import { getBreakingState } from "./breakingService.js";
import { getSuspensionDetailsList } from "./securityLog.js";
import { hashPhone } from "./adminAudit.js";

const QUERY_TIMEOUT_MS = 3_000;
const D = "────────────────────────";

function watNow() {
  return new Date().toLocaleString("en-GB", {
    timeZone: "Africa/Lagos",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

async function safeQuery(sql, params = [], fallback = []) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), QUERY_TIMEOUT_MS)
  );
  try {
    const res = await Promise.race([query(sql, params), timeout]);
    return res.rows;
  } catch (err) {
    logger.warn("[STATS] Query failed/timed out:", err.message);
    return fallback;
  }
}

// ── Section helpers ───────────────────────────────────────────────────────────

async function buildSecuritySection() {
  const rows = await safeQuery(
    `SELECT
       COUNT(*)                                                         AS total,
       COUNT(*) FILTER (WHERE event_type = 'impersonation')            AS imp_all,
       COUNT(*) FILTER (WHERE event_type = 'impersonation' AND detected_at >= CURRENT_DATE) AS imp_today,
       COUNT(*) FILTER (WHERE event_type = 'injection')                AS inj_all,
       COUNT(*) FILTER (WHERE event_type = 'injection'    AND detected_at >= CURRENT_DATE) AS inj_today,
       COUNT(*) FILTER (WHERE event_type = 'harmful')                  AS harm_all,
       COUNT(*) FILTER (WHERE event_type = 'harmful'      AND detected_at >= CURRENT_DATE) AS harm_today,
       COUNT(*) FILTER (WHERE event_type = 'admin_probe')              AS probe_all,
       COUNT(DISTINCT whatsapp_number)                                  AS unique_flagged
     FROM security_events`
  );
  const s = rows[0] || {};
  const suspended = getSuspensionDetailsList();

  return (
    `SECURITY & FLAGS\n` +
    `Impersonation Attempts (All Time): ${s.imp_all  || 0}\n` +
    `Impersonation Attempts (Today): ${s.imp_today   || 0}\n` +
    `Prompt Injection Attempts (All Time): ${s.inj_all || 0}\n` +
    `Prompt Injection Attempts (Today): ${s.inj_today  || 0}\n` +
    `Harmful Content Flags (All Time): ${s.harm_all  || 0}\n` +
    `Harmful Content Flags (Today): ${s.harm_today   || 0}\n` +
    `Admin Probe Attempts: ${s.probe_all             || 0}\n` +
    `Total Unique Flagged Users: ${s.unique_flagged  || 0}\n` +
    `Currently Suspended Users: ${suspended.length}`
  );
}

async function buildUserSection() {
  const rows = await safeQuery(
    `SELECT
       COUNT(*)                                                              AS total,
       COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '24 hours')      AS active_24h,
       COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '7 days')        AS active_7d,
       COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '30 days')       AS active_30d,
       COUNT(*) FILTER (WHERE opted_out = TRUE)                              AS opted_out,
       COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)                   AS new_today,
       COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days') AS new_week
     FROM users`
  );
  const u = rows[0] || {};

  return (
    `USER METRICS\n` +
    `Total Registered Users: ${u.total     || 0}\n` +
    `Active (Last 24 Hours): ${u.active_24h || 0}\n` +
    `Active (Last 7 Days): ${u.active_7d   || 0}\n` +
    `Active (Last 30 Days): ${u.active_30d  || 0}\n` +
    `Opted-Out Users: ${u.opted_out         || 0}\n` +
    `New Users Today: ${u.new_today         || 0}\n` +
    `New Users This Week: ${u.new_week      || 0}`
  );
}

async function buildSearchSection() {
  const [totals, topToday, topWeek, zeroToday] = await Promise.all([
    safeQuery(
      `SELECT COUNT(*) AS all_time,
              COUNT(*) FILTER (WHERE searched_at >= CURRENT_DATE) AS today
       FROM search_analytics`
    ),
    safeQuery(
      `SELECT keyword, COUNT(*) AS cnt FROM search_analytics
       WHERE searched_at >= CURRENT_DATE
       GROUP BY keyword ORDER BY cnt DESC LIMIT 1`
    ),
    safeQuery(
      `SELECT keyword, COUNT(*) AS cnt FROM search_analytics
       WHERE searched_at > NOW() - INTERVAL '7 days'
       GROUP BY keyword ORDER BY cnt DESC LIMIT 1`
    ),
    safeQuery(
      `SELECT COUNT(*) AS zero FROM search_analytics
       WHERE result_count = 0 AND searched_at >= CURRENT_DATE`
    ),
  ]);

  const t  = totals[0]   || {};
  const td = topToday[0] || {};
  const tw = topWeek[0]  || {};
  const z  = zeroToday[0] || {};

  return (
    `SEARCH INTELLIGENCE\n` +
    `Total Searches (All Time): ${t.all_time || 0}\n` +
    `Searches Today: ${t.today              || 0}\n` +
    `Top Keyword Today: ${td.keyword ? `${td.keyword} (${td.cnt} searches)` : "N/A"}\n` +
    `Top Keyword This Week: ${tw.keyword ? `${tw.keyword} (${tw.cnt} searches)` : "N/A"}\n` +
    `Zero-Result Searches (Today): ${z.zero || 0}`
  );
}

async function buildBroadcastSection() {
  const rows = await safeQuery(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'sent')              AS total_sent,
       MAX(sent_at)                                          AS last_sent,
       COUNT(*) FILTER (WHERE status = 'pending')           AS pending
     FROM broadcast_log`
  );
  const lastReachRows = await safeQuery(
    `SELECT total_recipients FROM broadcast_log WHERE status = 'sent'
     ORDER BY sent_at DESC LIMIT 1`
  );
  const b  = rows[0]       || {};
  const lr = lastReachRows[0] || {};

  const lastSentStr = b.last_sent
    ? new Date(b.last_sent).toLocaleString("en-GB", { timeZone: "Africa/Lagos", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "N/A";

  return (
    `BROADCAST HISTORY\n` +
    `Total Broadcasts Sent: ${b.total_sent     || 0}\n` +
    `Last Broadcast: ${lastSentStr}\n` +
    `Last Broadcast Reach: ${lr.total_recipients || 0} recipients\n` +
    `Scheduled Broadcasts Pending: ${b.pending || 0}`
  );
}

async function buildHealthSection() {
  const uptimeSecs = process.uptime();
  const uptimeDays = Math.floor(uptimeSecs / 86400);
  const uptimeHrs  = Math.floor((uptimeSecs % 86400) / 3600);

  const hRows = await safeQuery(
    `SELECT
       ROUND(AVG(avg_response_ms)) AS avg_ms,
       SUM(grok_success_count)     AS grok_ok,
       SUM(grok_failure_count)     AS grok_fail,
       SUM(wa_api_error_count)     AS wa_err,
       SUM(webhook_event_count)    AS webhooks,
       SUM(duplicate_blocked_count) AS dupes
     FROM health_metrics
     WHERE recorded_at >= CURRENT_DATE`
  );
  const h       = hRows[0]    || {};
  const grokOk  = Number(h.grok_ok  || botMetrics.grokSuccessToday);
  const grokFail= Number(h.grok_fail || botMetrics.grokFailuresToday);
  const grokRate = grokOk + grokFail > 0
    ? Math.round((grokOk / (grokOk + grokFail)) * 100)
    : 100;

  const avgMs   = h.avg_ms
    ? `${h.avg_ms}ms`
    : botMetrics.responseTimes.length > 0
    ? `${Math.round(botMetrics.responseTimes.reduce((a, b) => a + b, 0) / botMetrics.responseTimes.length)}ms`
    : "N/A";

  const breakState = getBreakingState();
  const breakSince = breakState.active && breakState.activatedAt
    ? new Date(breakState.activatedAt).toLocaleString("en-GB", { timeZone: "Africa/Lagos", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "N/A";

  return (
    `BOT HEALTH\n` +
    `Server Uptime: ${uptimeDays} day(s) ${uptimeHrs} hour(s)\n` +
    `Avg. Response Time (Today): ${avgMs}\n` +
    `Grok API Success Rate (Today): ${grokRate}%\n` +
    `Grok API Failures (Today): ${grokFail}\n` +
    `WhatsApp API Errors (Today): ${Number(h.wa_err) || botMetrics.waErrorsToday}\n` +
    `Webhook Events Processed (Today): ${Number(h.webhooks) || botMetrics.webhookEventsToday}\n` +
    `Duplicate Webhooks Blocked (Today): ${Number(h.dupes) || botMetrics.duplicatesBlockedToday}\n` +
    `Breaking News Mode: ${breakState.active ? "ACTIVE" : "INACTIVE"}\n` +
    `Breaking Mode Since: ${breakSince}`
  );
}

async function buildPromiseSection() {
  let total = 0, kept = 0, broken = 0, pending = 0;
  let lastDate = "N/A";
  for (const [, promises] of promiseTracker) {
    for (const p of promises) {
      total++;
      if (p.status === "KEPT")    kept++;
      if (p.status === "BROKEN")  broken++;
      if (p.status === "PENDING") pending++;
      if (!lastDate || p.date > lastDate) lastDate = p.date;
    }
  }
  return (
    `PROMISE TRACKER\n` +
    `Total Promises Logged: ${total}\n` +
    `Kept: ${kept} | Broken: ${broken} | Pending: ${pending}\n` +
    `Last Entry Added: ${lastDate}`
  );
}

// ── C2. Full dashboard ────────────────────────────────────────────────────────
export async function buildFullStats() {
  const [sec, usr, srch, bc, hlth, prm] = await Promise.all([
    buildSecuritySection().catch(() => "SECURITY — data temporarily unavailable"),
    buildUserSection().catch(() => "USER METRICS — data temporarily unavailable"),
    buildSearchSection().catch(() => "SEARCH INTELLIGENCE — data temporarily unavailable"),
    buildBroadcastSection().catch(() => "BROADCAST HISTORY — data temporarily unavailable"),
    buildHealthSection().catch(() => "BOT HEALTH — data temporarily unavailable"),
    buildPromiseSection().catch(() => "PROMISE TRACKER — data temporarily unavailable"),
  ]);

  return (
    `NAIJASCOPE BOT INTELLIGENCE DASHBOARD\n` +
    `Generated: ${watNow()} WAT\n` +
    `${D}\n\n${sec}\n\n${D}\n\n${usr}\n\n${D}\n\n${srch}\n\n${D}\n\n${bc}\n\n${D}\n\n${hlth}\n\n${D}\n\n${prm}\n${D}`
  );
}

// ── C3. Security detail ───────────────────────────────────────────────────────
export async function buildSecurityDetail() {
  const suspended = getSuspensionDetailsList();

  let body = `SECURITY DETAIL REPORT\n${D}\nCURRENTLY SUSPENDED USERS: ${suspended.length}\n`;

  if (suspended.length === 0) {
    body += "\nNo users are currently suspended.";
  } else {
    const display = suspended.slice(0, 10);
    for (const s of display) {
      const flaggedStr   = new Date(s.suspendedAt).toLocaleString("en-GB", { timeZone: "Africa/Lagos" });
      const expiresStr   = new Date(s.expiresAt).toLocaleString("en-GB", { timeZone: "Africa/Lagos" });
      body += (
        `\n${"─".repeat(18)}\n` +
        `User #${s.hash}\n` +
        `Flag Type: ${s.eventType}\n` +
        `Flagged: ${flaggedStr}\n` +
        `Suspension Expires: ${expiresStr}\n` +
        `Offending Message: ${s.messagePreview || "N/A"}...`
      );
    }
  }
  body += `\n${D}`;
  return body;
}

// ── C1. Sub-section exports ───────────────────────────────────────────────────
export async function buildUsersStats()    { return buildUserSection(); }
export async function buildHealthStats()   { return buildHealthSection(); }
export async function buildExportStats() {
  const full = await buildFullStats();
  return full.replace(/[^\x20-\x7E\n\r\t]/g, ""); // strip non-ASCII for plain-text export
}

// ── C4. Detailed /subscribers ─────────────────────────────────────────────────
export async function buildDetailedSubscribers() {
  const [engagement, growth, langs] = await Promise.all([
    safeQuery(
      `SELECT
         COUNT(*) FILTER (WHERE last_seen >= CURRENT_DATE)                 AS msgs_today,
         COUNT(*) FILTER (WHERE last_seen >= CURRENT_DATE - INTERVAL '7 days') AS msgs_week,
         COUNT(*) FILTER (WHERE last_seen >= CURRENT_DATE - INTERVAL '30 days') AS msgs_month,
         ROUND(AVG(msg_count) FILTER (WHERE last_seen > NOW() - INTERVAL '30 days'), 1) AS avg_per_user
       FROM users WHERE opted_out IS FALSE`
    ),
    safeQuery(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW())) AS new_month,
         COUNT(*) FILTER (WHERE created_at < NOW() - INTERVAL '30 days')  AS eligible,
         COUNT(*) FILTER (WHERE created_at < NOW() - INTERVAL '30 days' AND last_seen > NOW() - INTERVAL '30 days') AS retained,
         COUNT(*) FILTER (WHERE opted_out = TRUE AND opted_out_at >= DATE_TRUNC('month', NOW())) AS churned
       FROM users`
    ),
    safeQuery(
      `SELECT language_pref, COUNT(*) AS cnt
       FROM users WHERE opted_out IS FALSE OR opted_out IS NULL
       GROUP BY language_pref ORDER BY cnt DESC`
    ),
  ]);

  const e = engagement[0] || {};
  const g = growth[0]     || {};
  const retentionRate = Number(g.eligible) > 0
    ? Math.round((Number(g.retained) / Number(g.eligible)) * 100)
    : 100;

  const langLines = langs.map(l => {
    const label = { en: "English", ig: "Igbo", yo: "Yoruba", ha: "Hausa", pidgin: "Pidgin" }[l.language_pref] || l.language_pref || "English";
    return `${label}: ${l.cnt} users`;
  }).join("\n");

  return (
    `DETAILED USER ANALYTICS\n${D}\n` +
    `ENGAGEMENT\n` +
    `Messages Processed Today: ${e.msgs_today   || 0}\n` +
    `Messages This Week: ${e.msgs_week           || 0}\n` +
    `Messages This Month: ${e.msgs_month         || 0}\n` +
    `Avg. Messages Per User (30 Days): ${e.avg_per_user || 0}\n\n` +
    `GROWTH\n` +
    `New Users This Month: ${g.new_month         || 0}\n` +
    `Retention Rate (30-Day): ${retentionRate}%\n` +
    `Churn (Opted-Out This Month): ${g.churned   || 0}\n\n` +
    `LANGUAGE PREFERENCES\n` +
    `${langLines || "No data yet"}\n` +
    `${D}`
  );
}
