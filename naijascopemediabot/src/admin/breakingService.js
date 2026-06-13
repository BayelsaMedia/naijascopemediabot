/**
 * Module A3 — Breaking News Mode Service
 *
 * Manages global live-breaking-news state:
 *   - In-memory state for zero-latency reads on every sendText call
 *   - Persists to system_config table for cross-restart durability
 *   - Supports optional auto-expiry timer
 *   - Sends subscriber alerts on activation; close-out on expiry
 */

import { query } from "../utils/db.js";
import { logger } from "../utils/logger.js";

// ── In-memory state ───────────────────────────────────────────────────────────
let breakingState = {
  active:           false,
  topic:            "",
  activatedAt:      null,
  expiresAt:        null,
  activatedByHash:  null,
};
let expiryTimer = null;

// ── Public read helpers ───────────────────────────────────────────────────────
export function isBreakingActive()  { return breakingState.active; }
export function getBreakingState()  { return { ...breakingState }; }

// ── DB helpers ────────────────────────────────────────────────────────────────
async function getConfig(key) {
  try {
    const res = await query("SELECT value FROM system_config WHERE key = $1", [key]);
    return res.rows[0]?.value ?? null;
  } catch (_) { return null; }
}

async function setConfig(key, value) {
  try {
    await query(
      `INSERT INTO system_config (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, String(value ?? "")]
    );
  } catch (err) {
    logger.error(`[BREAKING] setConfig(${key}) failed:`, err.message);
  }
}

// ── Activation ────────────────────────────────────────────────────────────────
export async function activateBreaking(topic, expiryMs, adminHash) {
  const now       = new Date();
  const expiresAt = expiryMs ? new Date(Date.now() + expiryMs) : null;

  breakingState = {
    active:          true,
    topic:           topic || "",
    activatedAt:     now,
    expiresAt,
    activatedByHash: adminHash,
  };

  // Persist
  await setConfig("breaking_mode_active",       "true");
  await setConfig("breaking_mode_topic",         topic || "");
  await setConfig("breaking_mode_activated_at",  now.toISOString());
  await setConfig("breaking_mode_expires_at",    expiresAt ? expiresAt.toISOString() : "");
  await setConfig("breaking_mode_activated_by",  adminHash || "");

  // Schedule auto-expiry
  if (expiryMs) {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => deactivateBreaking(true), expiryMs);
    logger.info(`[BREAKING] Auto-expiry set for ${Math.round(expiryMs / 60_000)} minutes`);
  }

  // Alert all breaking-news subscribers (dynamic import avoids circular dep)
  setImmediate(async () => {
    try {
      const { getSubscribers } = await import("../services/alertService.js");
      const { sendText }       = await import("../services/whatsappService.js");
      const subscribers        = await getSubscribers("breaking_news");
      const msg = "NaijaScope Media has activated Live Coverage mode. Send NEWS to receive the latest updates.";
      for (const n of subscribers) {
        try {
          await sendText(n, msg);
          await new Promise(r => setTimeout(r, 600));
        } catch (_) {}
      }
      logger.info(`[BREAKING] Activation alerts sent to ${subscribers.length} subscriber(s)`);
    } catch (err) {
      logger.error("[BREAKING] Subscriber alert failed:", err.message);
    }
  });
}

// ── Deactivation ──────────────────────────────────────────────────────────────
export async function deactivateBreaking(sendCloseout = false) {
  const wasActive = breakingState.active;
  clearTimeout(expiryTimer);

  // Deactivate in-memory FIRST so close-out message doesn't carry the prefix
  breakingState = { active: false, topic: "", activatedAt: null, expiresAt: null, activatedByHash: null };

  await setConfig("breaking_mode_active",    "false");
  await setConfig("breaking_mode_expires_at", "");

  if (wasActive && sendCloseout) {
    setImmediate(async () => {
      try {
        const { getSubscribers } = await import("../services/alertService.js");
        const { sendText }       = await import("../services/whatsappService.js");
        const subscribers        = await getSubscribers("breaking_news");
        const msg = "NaijaScope Media Live Coverage has concluded. Visit www.bayelsamedia.com.ng for the full report.";
        for (const n of subscribers) {
          try {
            await sendText(n, msg);
            await new Promise(r => setTimeout(r, 600));
          } catch (_) {}
        }
        logger.info(`[BREAKING] Close-out sent to ${subscribers.length} subscriber(s)`);
      } catch (err) {
        logger.error("[BREAKING] Close-out send failed:", err.message);
      }
    });
  }
}

// ── Startup restore ───────────────────────────────────────────────────────────
export async function restoreBreakingState() {
  try {
    const active = await getConfig("breaking_mode_active");
    if (active !== "true") return;

    const topic          = (await getConfig("breaking_mode_topic"))         || "";
    const activatedAtStr = (await getConfig("breaking_mode_activated_at"))  || "";
    const expiresAtStr   = (await getConfig("breaking_mode_expires_at"))    || "";
    const activatedBy    = (await getConfig("breaking_mode_activated_by"))  || "";

    const now      = Date.now();
    const expiry   = expiresAtStr ? new Date(expiresAtStr).getTime() : null;

    if (expiry && now >= expiry) {
      // Already expired — deactivate silently (no close-out on restart)
      await deactivateBreaking(false);
      logger.info("[BREAKING] Expired breaking mode cleared on startup");
      return;
    }

    breakingState = {
      active:          true,
      topic,
      activatedAt:     activatedAtStr ? new Date(activatedAtStr) : new Date(),
      expiresAt:       expiry ? new Date(expiresAtStr) : null,
      activatedByHash: activatedBy,
    };

    if (expiry) {
      const remaining = expiry - now;
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => deactivateBreaking(true), remaining);
      logger.info(`[BREAKING] Breaking mode restored — expires in ${Math.round(remaining / 60_000)} minute(s)`);
    } else {
      logger.info("[BREAKING] Breaking mode restored — no expiry set");
    }
  } catch (err) {
    logger.error("[BREAKING] restoreBreakingState failed:", err.message);
  }
}

// ── Duration parser ───────────────────────────────────────────────────────────
/**
 * Parse a duration string like "4h", "30m", "2h30m" into milliseconds.
 * Returns null if the string does not match.
 */
export function parseDurationMs(str) {
  if (!str) return null;
  const hoursMatch   = str.match(/(\d+)\s*h/i);
  const minutesMatch = str.match(/(\d+)\s*m(?!s)/i);
  const hours   = hoursMatch   ? parseInt(hoursMatch[1], 10)   : 0;
  const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 0;
  if (hours === 0 && minutes === 0) return null;
  return (hours * 60 + minutes) * 60_000;
}
