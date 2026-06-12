import { sendText } from "../services/whatsappService.js";
import { getSubscribers } from "../services/alertService.js";
import { breakingLive, promiseTracker, analytics } from "../state/sessionState.js";
import { closeTicket } from "../services/supportService.js";
import { query } from "../utils/db.js";
import { logger } from "../utils/logger.js";

/**
 * Handle admin-only text commands.
 * Returns true if the command was handled, false to fall through to normal routing.
 */
export async function handleAdmin(from, rawText) {
  const upper = rawText.trim().toUpperCase();

  // ── Broadcast ──────────────────────────────────────────────────────────────
  if (upper.startsWith("BROADCAST ")) {
    const msg = rawText.slice(10).trim();
    const subscribers = await getSubscribers("daily_digest");
    let sent = 0;
    for (const number of subscribers) {
      await sendText(number, `📢 NaijaScope:\n\n${msg}`);
      await new Promise(r => setTimeout(r, 600));
      sent++;
    }
    await sendText(from, `✅ Broadcast sent to ${sent} subscribers.`);
    return true;
  }

  // ── Breaking news live mode ────────────────────────────────────────────────
  if (upper.startsWith("BREAKING ON ")) {
    const topic = rawText.slice(12).trim();
    breakingLive.active = true;
    breakingLive.topic  = topic;
    await sendText(from, `🔴 Live Breaking Mode ON — Topic: ${topic}`);
    const subscribers = await getSubscribers("breaking_news");
    for (const number of subscribers) {
      await sendText(number, `🔴 LIVE: NaijaScope is now covering:\n${topic}\n\nStay tuned 📡`);
      await new Promise(r => setTimeout(r, 600));
    }
    return true;
  }

  if (upper === "BREAKING OFF") {
    breakingLive.active = false;
    breakingLive.topic  = "";
    await sendText(from, "✅ Live Breaking Mode OFF.");
    return true;
  }

  if (upper.startsWith("LIVE ") && breakingLive.active) {
    const update = rawText.slice(5).trim();
    const subscribers = await getSubscribers("breaking_news");
    let sent = 0;
    for (const number of subscribers) {
      await sendText(number, `🔴 LIVE UPDATE — ${breakingLive.topic}\n\n${update}\n\nNaijaScope Media`);
      await new Promise(r => setTimeout(r, 600));
      sent++;
    }
    await sendText(from, `✅ Live update sent to ${sent} subscribers.`);
    return true;
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  if (upper === "STATS") {
    const today    = new Date().toISOString().slice(0, 10);
    const todayMsg = analytics.messagesPerDay.get(today) || 0;
    const topCmds  = [...analytics.commandCounts.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([cmd, n]) => `${cmd}: ${n}`).join(", ");
    const peakHour = analytics.peakHours.indexOf(Math.max(...analytics.peakHours));
    const dbUsers  = await query("SELECT COUNT(*) FROM users");
    await sendText(from,
      `📊 Bot Stats:\n\nUsers (DB): ${dbUsers.rows[0].count}\nActive sessions: ${analytics.totalUsers.size}\nMessages today: ${todayMsg}\nTop commands: ${topCmds || "—"}\nPeak hour: ${peakHour}:00 UTC\nLive mode: ${breakingLive.active ? "ON — " + breakingLive.topic : "OFF"}`
    );
    return true;
  }

  // ── Promise tracker ────────────────────────────────────────────────────────
  if (upper.startsWith("ADD PROMISE ")) {
    const parts = rawText.slice(12).split("|");
    if (parts.length < 2) { await sendText(from, "Usage: ADD PROMISE [politician] | [promise text] | [PENDING/KEPT/BROKEN]"); return true; }
    const politician = parts[0].trim().toLowerCase();
    const promise    = parts[1].trim();
    const status     = parts[2]?.trim().toUpperCase() || "PENDING";
    if (!promiseTracker.has(politician)) promiseTracker.set(politician, []);
    promiseTracker.get(politician).push({ promise, status, date: new Date().toISOString().slice(0, 10) });
    await sendText(from, `✅ Promise added for ${politician}: "${promise}" — ${status}`);
    return true;
  }

  if (upper.startsWith("UPDATE PROMISE ")) {
    const parts = rawText.slice(15).split("|");
    if (parts.length < 3) { await sendText(from, "Usage: UPDATE PROMISE [politician] | [index] | [KEPT/BROKEN/PENDING]"); return true; }
    const politician = parts[0].trim().toLowerCase();
    const idx        = parseInt(parts[1].trim()) - 1;
    const newStatus  = parts[2].trim().toUpperCase();
    const promises   = promiseTracker.get(politician);
    if (!promises || !promises[idx]) { await sendText(from, "Promise not found."); return true; }
    promises[idx].status = newStatus;
    await sendText(from, `✅ Updated: "${promises[idx].promise}" → ${newStatus}`);
    return true;
  }

  if (upper.startsWith("CLOSE TICKET ")) {
    const ref = rawText.slice(13).trim();
    await closeTicket(ref);
    await sendText(from, `✅ Ticket ${ref} closed.`);
    return true;
  }

  return false; // not an admin command
}

/**
 * 2c. Admin authentication — verified exclusively by phone number from the webhook payload.
 * Supports a comma-separated ADMIN_PHONE_NUMBERS env var (preferred) or the legacy
 * single-number ADMIN_NUMBER env var. Message content is NEVER used for verification.
 */
export function isAdmin(from) {
  const multiList = process.env.ADMIN_PHONE_NUMBERS;
  if (multiList) {
    const approved = multiList.split(",").map(n => n.trim()).filter(Boolean);
    return approved.includes(from);
  }
  // Legacy fallback
  return !!(process.env.ADMIN_NUMBER && from === process.env.ADMIN_NUMBER);
}
