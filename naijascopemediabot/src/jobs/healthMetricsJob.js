/**
 * Module C — Health Metrics Cron Job
 *
 * Inserts a health_metrics snapshot every 5 minutes.
 * Reads from the in-memory botMetrics object in sessionState.js.
 */

import cron from "node-cron";
import { query } from "../utils/db.js";
import { botMetrics, analytics } from "../state/sessionState.js";
import { logger } from "../utils/logger.js";

async function recordHealthSnapshot() {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const avgMs = botMetrics.responseTimes.length > 0
      ? Math.round(botMetrics.responseTimes.reduce((a, b) => a + b, 0) / botMetrics.responseTimes.length)
      : null;

    const webhookCount = analytics.messagesPerDay.get(today) || 0;

    await query(
      `INSERT INTO health_metrics
         (avg_response_ms, grok_success_count, grok_failure_count, wa_api_error_count, webhook_event_count, duplicate_blocked_count)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        avgMs,
        botMetrics.grokSuccessToday,
        botMetrics.grokFailuresToday,
        botMetrics.waErrorsToday,
        webhookCount,
        botMetrics.duplicatesBlockedToday,
      ]
    );

    // Trim response-time buffer to last 100 entries
    botMetrics.responseTimes = botMetrics.responseTimes.slice(-100);

    logger.debug(`[HEALTH] Snapshot recorded — avgMs=${avgMs}, grokOk=${botMetrics.grokSuccessToday}, waErr=${botMetrics.waErrorsToday}`);
  } catch (err) {
    logger.error("[HEALTH] Snapshot failed:", err.message);
  }
}

export function startHealthMetricsJob() {
  cron.schedule("*/5 * * * *", recordHealthSnapshot);
  logger.info("[CRON] Health metrics job started (every 5 minutes)");
}
