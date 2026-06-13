/**
 * Module A1 — Admin Audit Log & Probe Detection
 * Provides:
 *   - hashPhone(number)              — one-way hash for privacy-safe logging
 *   - logAdminAction(from, cmd, out) — persist every admin command with outcome
 *   - recordProbeAttempt(from)       — sliding-window counter; alerts admin at threshold
 *   - getAdminNumbers()              — resolve admin phone list from env
 */

import crypto from "crypto";
import { query } from "../utils/db.js";
import { logger } from "../utils/logger.js";

// ── Phone hashing ─────────────────────────────────────────────────────────────
export function hashPhone(number) {
  return crypto.createHash("sha256").update(String(number)).digest("hex").slice(0, 16);
}

// ── Admin phone resolver ──────────────────────────────────────────────────────
export function getAdminNumbers() {
  const multi = process.env.ADMIN_PHONE_NUMBERS;
  if (multi) return multi.split(",").map(n => n.trim()).filter(Boolean);
  return process.env.ADMIN_NUMBER ? [process.env.ADMIN_NUMBER] : [];
}

// ── Audit logging ─────────────────────────────────────────────────────────────
export async function logAdminAction(from, command, outcome) {
  try {
    await query(
      "INSERT INTO admin_audit_log (phone_hash, command, outcome) VALUES ($1, $2, $3)",
      [hashPhone(from), String(command).slice(0, 500), String(outcome).slice(0, 50)]
    );
  } catch (err) {
    logger.error("[AUDIT] Log write failed:", err.message);
  }
}

// ── Probe detection: sliding 1-hour window per phone ─────────────────────────
const probeCache = new Map(); // from → timestamps[]
const PROBE_WINDOW_MS = 60 * 60 * 1_000; // 1 hour
const PROBE_THRESHOLD = 5;

export async function recordProbeAttempt(from) {
  const now  = Date.now();
  const prev = (probeCache.get(from) || []).filter(t => now - t < PROBE_WINDOW_MS);
  prev.push(now);
  probeCache.set(from, prev);

  if (prev.length < PROBE_THRESHOLD) return;

  // Threshold reached — notify all admin phones
  logger.warn(`[SECURITY] Probe threshold (${PROBE_THRESHOLD}) reached from ${hashPhone(from)}`);

  const adminNums = getAdminNumbers();
  if (adminNums.length > 0) {
    // Dynamic import to avoid circular dependency at load time
    const { sendText } = await import("../services/whatsappService.js");
    const alert = `NaijaScope Media — Security Alert\n\nA phone number has sent ${prev.length} unrecognised admin-style commands within the past hour.\n\nPhone hash: ${hashPhone(from)}\n\nReview is recommended.`;
    for (const admin of adminNums) {
      try { await sendText(admin, alert); } catch (_) {}
    }
  }

  // Persist to DB and reset in-memory counter
  try {
    await query("INSERT INTO admin_probe_log (from_hash) VALUES ($1)", [hashPhone(from)]);
  } catch (_) {}
  probeCache.delete(from);
}
