/**
 * Module C — Security Event Logger
 *
 * Records impersonation, injection, harmful-content, and admin-probe events
 * to the security_events table. Also manages the in-memory suspension registry
 * for the /stats security detail report.
 */

import { query } from "../utils/db.js";
import { logger } from "../utils/logger.js";
import { hashPhone } from "./adminAudit.js";
import { suspensionDetails } from "../state/sessionState.js";

// ── Log a security event to DB ────────────────────────────────────────────────
export async function logSecurityEvent(whatsappNumber, eventType, messagePreview, suspensionExpiresAt = null) {
  try {
    await query(
      `INSERT INTO security_events (whatsapp_number, event_type, message_preview, suspension_expires_at)
       VALUES ($1, $2, $3, $4)`,
      [
        whatsappNumber,
        eventType,
        (messagePreview || "").slice(0, 200),
        suspensionExpiresAt || null,
      ]
    );
  } catch (err) {
    logger.error("[SECURITY_LOG] DB write failed:", err.message);
  }
}

// ── In-memory suspension details (for /stats security detail) ─────────────────
export function recordSuspension(from, eventType, messagePreview) {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000);
  suspensionDetails.set(from, {
    hash:           hashPhone(from),
    eventType,
    messagePreview: (messagePreview || "").slice(0, 60),
    suspendedAt:    new Date(),
    expiresAt,
  });
  // Log to DB
  logSecurityEvent(from, eventType, messagePreview, expiresAt).catch(() => {});
}

// ── Lift a suspension by hash (for /unsuspend) ────────────────────────────────
export function liftSuspensionByHash(hash) {
  for (const [phone, detail] of suspensionDetails) {
    if (detail.hash === hash) {
      suspensionDetails.delete(phone);
      return phone;
    }
  }
  return null; // not found
}

export function getSuspensionDetailsList() {
  const now = Date.now();
  const result = [];
  for (const [phone, detail] of suspensionDetails) {
    if (detail.expiresAt && new Date(detail.expiresAt).getTime() > now) {
      result.push({ phone, ...detail });
    } else {
      suspensionDetails.delete(phone); // clean up expired
    }
  }
  return result;
}
