/**
 * Module A2 — Scheduled Broadcast Job
 *
 * Runs every minute. Dispatches any broadcast_log entries where:
 *   - status = 'pending' AND scheduled_at <= NOW()   (due scheduled broadcasts)
 *   - status = 'sending'                              (crashed mid-dispatch; resume)
 */

import cron from "node-cron";
import { query } from "../utils/db.js";
import { dispatchBroadcast, getRecipients, updateBroadcastStatus } from "../admin/broadcastService.js";
import { logger } from "../utils/logger.js";

const ADMIN_NUMBER_RESOLVED = () => {
  const multi = process.env.ADMIN_PHONE_NUMBERS;
  if (multi) return multi.split(",").map(n => n.trim()).filter(Boolean);
  return process.env.ADMIN_NUMBER ? [process.env.ADMIN_NUMBER] : [];
};

async function runScheduledBroadcasts() {
  try {
    // Find broadcasts due for dispatch (scheduled) or interrupted (sending)
    const res = await query(
      `SELECT id, message_body, broadcast_type, segment, resume_from_index
       FROM broadcast_log
       WHERE (status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW())
          OR  status = 'sending'
       ORDER BY scheduled_at ASC NULLS LAST, id ASC
       LIMIT 5`
    );
    if (res.rows.length === 0) return;

    for (const row of res.rows) {
      logger.info(`[BROADCAST_JOB] Processing log #${row.id} (type=${row.broadcast_type}, segment=${row.segment})`);
      try {
        const recipients = await getRecipients(row.segment || "all");
        const report = await dispatchBroadcast(row.id, recipients, row.message_body);
        logger.info(`[BROADCAST_JOB] Log #${row.id} done — sent=${report.successful}, failed=${report.failed}`);

        // Notify admins
        const { sendText } = await import("../services/whatsappService.js");
        const admins = ADMIN_NUMBER_RESOLVED();
        const summary = `NaijaScope Broadcast Report — ID #${row.id}\n\nDispatch complete.\nRecipients targeted: ${report.total}\nSuccessful deliveries: ${report.successful}\nFailed deliveries: ${report.failed}`;
        for (const admin of admins) {
          try { await sendText(admin, summary); } catch (_) {}
        }
      } catch (err) {
        logger.error(`[BROADCAST_JOB] Log #${row.id} dispatch error:`, err.message);
        await updateBroadcastStatus(row.id, "failed");
      }
    }
  } catch (err) {
    logger.error("[BROADCAST_JOB] Job error:", err.message);
  }
}

export function startScheduledBroadcastJob() {
  // Check every minute for due or interrupted broadcasts
  cron.schedule("* * * * *", runScheduledBroadcasts);
  logger.info("[CRON] Scheduled broadcast job started (every minute)");
}
