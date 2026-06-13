/**
 * Module A2 — Broadcast Service
 *
 * Handles recipient resolution, broadcast logging, and rate-limited dispatch.
 * Key capabilities:
 *   - Three segments: all / last_7d / last_30d (excludes opted-out users)
 *   - 80 messages per second rate cap
 *   - Resume from last successful index on restart/failure
 *   - Broadcast log entries created before dispatch (auditable)
 */

import { query } from "../utils/db.js";
import { logger } from "../utils/logger.js";

const SEND_RATE_MS = Math.ceil(1_000 / 80); // 12.5 ms → ~80 msg/s

// ── Recipient resolution ──────────────────────────────────────────────────────
export async function getRecipients(segment = "all") {
  let intervalClause = "";
  if (segment === "last_7d")  intervalClause = "AND u.last_seen > NOW() - INTERVAL '7 days'";
  if (segment === "last_30d") intervalClause = "AND u.last_seen > NOW() - INTERVAL '30 days'";

  const res = await query(
    `SELECT DISTINCT us.whatsapp_number
     FROM user_subscriptions us
     JOIN users u ON u.whatsapp_number = us.whatsapp_number
     WHERE (u.opted_out IS FALSE OR u.opted_out IS NULL)
     ${intervalClause}
     ORDER BY us.whatsapp_number`
  );
  return res.rows.map(r => r.whatsapp_number);
}

export async function countRecipients(segment = "all") {
  const rows = await getRecipients(segment);
  return rows.length;
}

// ── Broadcast log helpers ─────────────────────────────────────────────────────
export async function createBroadcastLog({ messageBody, broadcastType, segment, scheduledAt, adminPhoneHash }) {
  const res = await query(
    `INSERT INTO broadcast_log
       (message_body, broadcast_type, segment, scheduled_at, admin_phone_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      messageBody,
      broadcastType,
      segment || "all",
      scheduledAt || null,
      adminPhoneHash || null,
      scheduledAt ? "scheduled" : "pending",
    ]
  );
  return res.rows[0].id;
}

export async function updateBroadcastStatus(id, status, extra = {}) {
  const sets = ["status = $2"];
  const vals = [id, status];
  if (extra.sentAt)               { vals.push(extra.sentAt);               sets.push(`sent_at = $${vals.length}`); }
  if (extra.totalRecipients != null){ vals.push(extra.totalRecipients);    sets.push(`total_recipients = $${vals.length}`); }
  if (extra.successful != null)   { vals.push(extra.successful);           sets.push(`successful_deliveries = $${vals.length}`); }
  if (extra.failed != null)       { vals.push(extra.failed);               sets.push(`failed_deliveries = $${vals.length}`); }
  if (extra.resumeIndex != null)  { vals.push(extra.resumeIndex);          sets.push(`resume_from_index = $${vals.length}`); }
  await query(`UPDATE broadcast_log SET ${sets.join(", ")} WHERE id = $1`, vals);
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
/**
 * Dispatch a broadcast. Returns a summary object on completion.
 * Supports resume from the last persisted resume_from_index.
 */
export async function dispatchBroadcast(logId, recipients, messageBody) {
  // Read existing progress (for resume)
  const progressRes = await query(
    "SELECT resume_from_index, successful_deliveries, failed_deliveries FROM broadcast_log WHERE id = $1",
    [logId]
  );
  const prog = progressRes.rows[0] || {};
  let startIndex  = prog.resume_from_index       || 0;
  let successful  = prog.successful_deliveries   || 0;
  let failed      = prog.failed_deliveries       || 0;

  // Mark as sending
  await updateBroadcastStatus(logId, "sending", {
    sentAt: new Date(),
    totalRecipients: recipients.length,
  });

  // Dynamic import to avoid circular dep (whatsappService → breakingService ← this file would not cycle)
  const { sendText } = await import("../services/whatsappService.js");

  try {
    for (let i = startIndex; i < recipients.length; i++) {
      const number = recipients[i];
      try {
        await sendText(number, messageBody);
        successful++;
      } catch (err) {
        logger.error(`[BROADCAST] Delivery failed for ${number}:`, err.message);
        failed++;
      }

      // Persist progress every 25 messages for crash recovery
      if ((i + 1) % 25 === 0 || i === recipients.length - 1) {
        await updateBroadcastStatus(logId, "sending", {
          resumeIndex: i + 1,
          successful,
          failed,
        });
      }

      await new Promise(r => setTimeout(r, SEND_RATE_MS));
    }

    await updateBroadcastStatus(logId, "sent", {
      resumeIndex: recipients.length,
      successful,
      failed,
    });
  } catch (err) {
    await updateBroadcastStatus(logId, "failed", { successful, failed });
    throw err;
  }

  const estimatedMinutes = Math.max(1, Math.ceil((recipients.length * SEND_RATE_MS) / 60_000));
  return { total: recipients.length, successful, failed, estimatedMinutes };
}

// ── Estimated delivery time ───────────────────────────────────────────────────
export function estimateDeliveryMinutes(recipientCount) {
  return Math.max(1, Math.ceil((recipientCount * SEND_RATE_MS) / 60_000));
}
