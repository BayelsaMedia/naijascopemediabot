/**
 * Module A — Admin Broadcast Dashboard
 * Handles all admin commands (text + interactive wizard steps).
 *
 * LOCKED: isAdmin() export interface must remain stable.
 */

import { sendText, sendButtons, sendList } from "../services/whatsappService.js";
import { getSubscribers } from "../services/alertService.js";
import { breakingLive, promiseTracker, analytics, adminWizardState } from "../state/sessionState.js";
import { closeTicket } from "../services/supportService.js";
import { query } from "../utils/db.js";
import { logger } from "../utils/logger.js";

import { hashPhone, logAdminAction, getAdminNumbers } from "../admin/adminAudit.js";
import {
  activateBreaking, deactivateBreaking, getBreakingState, parseDurationMs,
} from "../admin/breakingService.js";
import {
  getRecipients, countRecipients, createBroadcastLog, dispatchBroadcast, estimateDeliveryMinutes,
} from "../admin/broadcastService.js";

// ── A1. Authentication — verified by phone number only ────────────────────────
export function isAdmin(from) {
  const multiList = process.env.ADMIN_PHONE_NUMBERS;
  if (multiList) {
    const approved = multiList.split(",").map(n => n.trim()).filter(Boolean);
    return approved.includes(from);
  }
  return !!(process.env.ADMIN_NUMBER && from === process.env.ADMIN_NUMBER);
}

// ── Admin menu ────────────────────────────────────────────────────────────────
async function sendAdminMenu(to) {
  await sendText(to,
    `NaijaScope Media — Admin Console\n\n` +
    `Broadcast:\n` +
    `  /broadcast — Launch broadcast wizard\n\n` +
    `Breaking News:\n` +
    `  /breaking on [4h|2h|30m] — Activate live coverage mode\n` +
    `  /breaking off — Deactivate live coverage mode\n` +
    `  /breaking status — Show current status\n\n` +
    `Analytics:\n` +
    `  /subscribers — Subscriber counts by segment\n` +
    `  STATS — Session analytics\n\n` +
    `Promise Tracker:\n` +
    `  ADD PROMISE [politician] | [promise] | [PENDING/KEPT/BROKEN]\n` +
    `  UPDATE PROMISE [politician] | [index] | [status]\n\n` +
    `Journalist:\n` +
    `  CLOSE TICKET [ref]`
  );
}

// ── A2. /broadcast — multi-step wizard ───────────────────────────────────────

async function sendBroadcastTypeMenu(to) {
  await sendList(
    to,
    "Select broadcast type to proceed.",
    "Select Type",
    [{
      title: "Broadcast Options",
      rows: [
        { id: "broadcast_type_instant",     title: "Instant Broadcast",   description: "Send immediately to all subscribers"        },
        { id: "broadcast_type_scheduled",   title: "Scheduled Broadcast", description: "Queue for a specific date and time"          },
        { id: "broadcast_type_segment_7d",  title: "Segment — Last 7 Days",  description: "Users active in the last 7 days"         },
        { id: "broadcast_type_segment_30d", title: "Segment — Last 30 Days", description: "Users active in the last 30 days"        },
        { id: "broadcast_type_cancel",      title: "Cancel",              description: "Return to admin menu"                       },
      ],
    }],
    { header: "Admin Broadcast Centre" }
  );
}

async function sendComposePrompt(to) {
  await sendText(to,
    `Please compose your broadcast message now.\n\n` +
    `Begin with a category prefix for best delivery:\n` +
    `[BREAKING]  [ANNOUNCEMENT]  [ALERT]  [UPDATE]\n\n` +
    `Type and send your message.`
  );
}

async function sendBroadcastPreview(to, body, recipientCount) {
  await sendText(to,
    `BROADCAST PREVIEW\n` +
    `─────────────────\n` +
    `${body}\n` +
    `─────────────────\n\n` +
    `This broadcast will reach ${recipientCount} subscriber(s).`
  );
  await sendButtons(to, "Confirm or edit your broadcast:", [
    { id: "broadcast_confirm", title: "Confirm & Send" },
    { id: "broadcast_edit",    title: "Edit Message"   },
    { id: "broadcast_cancel",  title: "Cancel"         },
  ]);
}

// ── A2 interactive replies ────────────────────────────────────────────────────
export async function handleAdminInteractive(from, replyId) {
  const wizard = adminWizardState.get(from) || {};

  // ── Broadcast type selection ──────────────────────────────────────────────
  if (replyId.startsWith("broadcast_type_")) {
    if (replyId === "broadcast_type_cancel") {
      adminWizardState.delete(from);
      await logAdminAction(from, "broadcast_type_cancel", "cancelled");
      await sendAdminMenu(from);
      return;
    }

    const typeMap = {
      broadcast_type_instant:     { type: "instant",   segment: "all"      },
      broadcast_type_scheduled:   { type: "scheduled", segment: "all"      },
      broadcast_type_segment_7d:  { type: "segment",   segment: "last_7d"  },
      broadcast_type_segment_30d: { type: "segment",   segment: "last_30d" },
    };
    const chosen = typeMap[replyId];
    if (!chosen) return;

    adminWizardState.set(from, { step: "compose", ...chosen, body: "" });
    await sendComposePrompt(from);
    return;
  }

  // ── Confirm & Send ────────────────────────────────────────────────────────
  if (replyId === "broadcast_confirm") {
    if (!wizard.body) {
      await sendText(from, "No message body found. Please restart the wizard with /broadcast.");
      adminWizardState.delete(from);
      return;
    }

    if (wizard.type === "scheduled") {
      // Transition to scheduling step — ask for date/time
      adminWizardState.set(from, { ...wizard, step: "schedule" });
      await sendText(from,
        `Please enter the scheduled date and time in this exact format:\n\n` +
        `DD/MM/YYYY HH:MM\n\n` +
        `Example: 25/12/2025 09:00\n\n` +
        `All times are West Africa Time (WAT).`
      );
      return;
    }

    // Instant / segment — dispatch immediately
    await initiateDispatch(from, wizard);
    return;
  }

  // ── Edit message ──────────────────────────────────────────────────────────
  if (replyId === "broadcast_edit") {
    adminWizardState.set(from, { ...wizard, step: "compose", body: "" });
    await sendComposePrompt(from);
    return;
  }

  // ── Cancel ────────────────────────────────────────────────────────────────
  if (replyId === "broadcast_cancel") {
    adminWizardState.delete(from);
    await logAdminAction(from, "broadcast_cancel", "cancelled");
    await sendText(from, "Broadcast cancelled. No messages were sent.");
    return;
  }
}

// ── Dispatch helper (instant / segment) ──────────────────────────────────────
async function initiateDispatch(from, wizard) {
  adminWizardState.delete(from);
  try {
    const recipients  = await getRecipients(wizard.segment);
    const logId       = await createBroadcastLog({
      messageBody:    wizard.body,
      broadcastType:  wizard.type,
      segment:        wizard.segment,
      scheduledAt:    null,
      adminPhoneHash: hashPhone(from),
    });

    const estMins = estimateDeliveryMinutes(recipients.length);
    await sendText(from,
      `Broadcast initiated.\n\n` +
      `Recipients targeted: ${recipients.length}\n` +
      `Estimated delivery time: ${estMins} minute(s)\n\n` +
      `A delivery report will follow when dispatch completes.`
    );
    await logAdminAction(from, `broadcast_dispatch id=${logId}`, "started");

    // Non-blocking dispatch
    dispatchBroadcast(logId, recipients, wizard.body)
      .then(async (report) => {
        await logAdminAction(from, `broadcast_dispatch id=${logId}`, "sent");
        await sendText(from,
          `Broadcast delivery complete — ID #${logId}\n\n` +
          `Successful deliveries: ${report.successful}\n` +
          `Failed deliveries: ${report.failed}`
        );
      })
      .catch(async (err) => {
        logger.error(`[BROADCAST] Dispatch error log #${logId}:`, err.message);
        await logAdminAction(from, `broadcast_dispatch id=${logId}`, "error");
        await sendText(from,
          `Broadcast ID #${logId} encountered an error mid-dispatch and will resume automatically on the next scheduled check.`
        );
      });
  } catch (err) {
    logger.error("[ADMIN] initiateDispatch error:", err.message);
    await sendText(from, "An error occurred initiating the broadcast. Please try again.");
  }
}

// ── Dispatch helper (scheduled) ───────────────────────────────────────────────
async function scheduleDispatch(from, wizard, scheduledAt) {
  adminWizardState.delete(from);
  try {
    const recipientCount = await countRecipients(wizard.segment);
    const logId = await createBroadcastLog({
      messageBody:    wizard.body,
      broadcastType:  "scheduled",
      segment:        wizard.segment,
      scheduledAt,
      adminPhoneHash: hashPhone(from),
    });

    await logAdminAction(from, `broadcast_schedule id=${logId}`, "queued");
    await sendText(from,
      `Broadcast scheduled — ID #${logId}\n\n` +
      `Estimated recipients: ${recipientCount}\n` +
      `Delivery time: ${scheduledAt.toLocaleString("en-GB", { timeZone: "Africa/Lagos" })} WAT\n\n` +
      `The broadcast will dispatch automatically at the scheduled time.`
    );
  } catch (err) {
    logger.error("[ADMIN] scheduleDispatch error:", err.message);
    await sendText(from, "An error occurred scheduling the broadcast. Please try again.");
  }
}

// ── A3. /breaking commands ────────────────────────────────────────────────────
async function handleBreakingCommand(from, rawText) {
  const lower = rawText.trim().toLowerCase();

  // /breaking status
  if (lower === "/breaking status") {
    const state = getBreakingState();
    if (!state.active) {
      await sendText(from, "Breaking News Mode: INACTIVE\n\nNo live coverage is currently active.");
    } else {
      const elapsed = state.activatedAt
        ? Math.round((Date.now() - new Date(state.activatedAt).getTime()) / 60_000)
        : "—";
      const expiresMsg = state.expiresAt
        ? `\nAuto-expires: ${new Date(state.expiresAt).toLocaleString("en-GB", { timeZone: "Africa/Lagos" })} WAT`
        : "\nNo auto-expiry set.";
      await sendText(from,
        `Breaking News Mode: ACTIVE\n\n` +
        `Active for: ${elapsed} minute(s)` +
        expiresMsg
      );
    }
    await logAdminAction(from, "/breaking status", "ok");
    return true;
  }

  // /breaking off
  if (lower === "/breaking off") {
    breakingLive.active = false; // keep legacy state in sync
    breakingLive.topic  = "";
    await deactivateBreaking(true);
    await sendText(from, "Breaking News Mode: DEACTIVATED\n\nAll subscribers have been notified.");
    await logAdminAction(from, "/breaking off", "deactivated");
    return true;
  }

  // /breaking on [duration?]
  if (lower.startsWith("/breaking on")) {
    const rest     = rawText.trim().slice(12).trim(); // text after "/breaking on"
    const expiryMs = parseDurationMs(rest);

    breakingLive.active = true; // keep legacy state in sync
    breakingLive.topic  = rest && !expiryMs ? rest : "Live Coverage";

    await activateBreaking(
      rest && !expiryMs ? rest : "Live Coverage",
      expiryMs,
      hashPhone(from)
    );

    const expiryNote = expiryMs
      ? `Auto-expiry: ${Math.round(expiryMs / 60_000)} minute(s).`
      : "No auto-expiry set. Send /breaking off to deactivate.";

    await sendText(from,
      `Breaking News Mode: ACTIVATED\n\n` +
      `${expiryNote}\n\n` +
      `All breaking-news subscribers have been alerted.`
    );
    await logAdminAction(from, `/breaking on${rest ? " " + rest : ""}`, "activated");
    return true;
  }

  return false;
}

// ── A2. /subscribers command ──────────────────────────────────────────────────
async function handleSubscribersCommand(from) {
  const [all, last7, last30] = await Promise.all([
    countRecipients("all"),
    countRecipients("last_7d"),
    countRecipients("last_30d"),
  ]);
  const breakingCount = (await getSubscribers("breaking_news")).length;
  const digestCount   = (await getSubscribers("daily_digest")).length;

  await sendText(from,
    `NaijaScope Media — Subscriber Report\n\n` +
    `All opted-in users: ${all}\n` +
    `Active last 7 days: ${last7}\n` +
    `Active last 30 days: ${last30}\n\n` +
    `Daily Digest subscribers: ${digestCount}\n` +
    `Breaking News subscribers: ${breakingCount}`
  );
  await logAdminAction(from, "/subscribers", "ok");
}

// ── Main text command handler ──────────────────────────────────────────────────
export async function handleAdmin(from, rawText) {
  const upper   = rawText.trim().toUpperCase();
  const trimmed = rawText.trim();
  const wizard  = adminWizardState.get(from);

  // ── Wizard: compose step ──────────────────────────────────────────────────
  if (wizard?.step === "compose") {
    // If admin is mid-compose and sends a new /command, abort wizard
    if (trimmed.startsWith("/")) {
      adminWizardState.delete(from);
      // Fall through to command handling below
    } else {
      const body = trimmed;
      adminWizardState.set(from, { ...wizard, step: "preview", body });

      const recipientCount = await countRecipients(wizard.segment);
      await sendBroadcastPreview(from, body, recipientCount);
      return true;
    }
  }

  // ── Wizard: schedule step ─────────────────────────────────────────────────
  if (wizard?.step === "schedule") {
    const dateMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
    if (!dateMatch) {
      await sendText(from,
        `Invalid format. Please use DD/MM/YYYY HH:MM\n\nExample: 25/12/2025 09:00`
      );
      return true;
    }
    const [, dd, mm, yyyy, hh, min] = dateMatch;
    // Parse as WAT (UTC+1)
    const scheduledAt = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00+01:00`);
    if (isNaN(scheduledAt.getTime()) || scheduledAt < new Date()) {
      await sendText(from, "The scheduled time must be in the future. Please enter a valid future date and time.");
      return true;
    }
    await scheduleDispatch(from, wizard, scheduledAt);
    return true;
  }

  // ── /admin — show help menu ────────────────────────────────────────────────
  if (upper === "/ADMIN") {
    await sendAdminMenu(from);
    await logAdminAction(from, "/admin", "ok");
    return true;
  }

  // ── /broadcast ────────────────────────────────────────────────────────────
  if (upper === "/BROADCAST") {
    adminWizardState.delete(from); // reset any existing wizard
    await sendBroadcastTypeMenu(from);
    await logAdminAction(from, "/broadcast", "wizard_started");
    return true;
  }

  // ── /breaking ─────────────────────────────────────────────────────────────
  if (trimmed.toLowerCase().startsWith("/breaking")) {
    const handled = await handleBreakingCommand(from, trimmed);
    if (handled) return true;
  }

  // ── /subscribers ──────────────────────────────────────────────────────────
  if (upper === "/SUBSCRIBERS") {
    await handleSubscribersCommand(from);
    return true;
  }

  // ── Legacy BROADCAST [message] — kept for backward compatibility ───────────
  if (upper.startsWith("BROADCAST ")) {
    const msg = rawText.slice(10).trim();
    const subscribers = await getSubscribers("daily_digest");
    let sent = 0;
    for (const number of subscribers) {
      await sendText(number, `NaijaScope Media Announcement:\n\n${msg}`);
      await new Promise(r => setTimeout(r, 600));
      sent++;
    }
    await sendText(from, `Broadcast sent to ${sent} subscriber(s).`);
    await logAdminAction(from, "BROADCAST (legacy)", "sent");
    return true;
  }

  // ── Legacy BREAKING ON [topic] ────────────────────────────────────────────
  if (upper.startsWith("BREAKING ON ")) {
    const topic = rawText.slice(12).trim();
    breakingLive.active = true;
    breakingLive.topic  = topic;
    await activateBreaking(topic, null, hashPhone(from));
    await sendText(from, `Breaking News Mode activated. Topic: ${topic}`);
    await logAdminAction(from, "BREAKING ON (legacy)", "activated");
    return true;
  }

  if (upper === "BREAKING OFF") {
    breakingLive.active = false;
    breakingLive.topic  = "";
    await deactivateBreaking(true);
    await sendText(from, "Breaking News Mode deactivated.");
    await logAdminAction(from, "BREAKING OFF (legacy)", "deactivated");
    return true;
  }

  // ── Legacy LIVE update ────────────────────────────────────────────────────
  if (upper.startsWith("LIVE ") && breakingLive.active) {
    const update = rawText.slice(5).trim();
    const subscribers = await getSubscribers("breaking_news");
    let sent = 0;
    for (const number of subscribers) {
      await sendText(number, `NaijaScope Media — Live Update\n\n${update}`);
      await new Promise(r => setTimeout(r, 600));
      sent++;
    }
    await sendText(from, `Live update sent to ${sent} subscriber(s).`);
    return true;
  }

  // ── STATS ─────────────────────────────────────────────────────────────────
  if (upper === "STATS") {
    const today    = new Date().toISOString().slice(0, 10);
    const todayMsg = analytics.messagesPerDay.get(today) || 0;
    const topCmds  = [...analytics.commandCounts.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([cmd, n]) => `${cmd}: ${n}`).join(", ");
    const peakHour = analytics.peakHours.indexOf(Math.max(...analytics.peakHours));
    const dbUsers  = await query("SELECT COUNT(*) FROM users");
    const breakState = getBreakingState();
    await sendText(from,
      `NaijaScope Bot Statistics\n\n` +
      `Users (DB): ${dbUsers.rows[0].count}\n` +
      `Active sessions: ${analytics.totalUsers.size}\n` +
      `Messages today: ${todayMsg}\n` +
      `Top commands: ${topCmds || "—"}\n` +
      `Peak hour: ${peakHour}:00 UTC\n` +
      `Breaking mode: ${breakState.active ? "ACTIVE" : "INACTIVE"}`
    );
    return true;
  }

  // ── Promise tracker ───────────────────────────────────────────────────────
  if (upper.startsWith("ADD PROMISE ")) {
    const parts = rawText.slice(12).split("|");
    if (parts.length < 2) {
      await sendText(from, "Usage: ADD PROMISE [politician] | [promise text] | [PENDING/KEPT/BROKEN]");
      return true;
    }
    const politician = parts[0].trim().toLowerCase();
    const promise    = parts[1].trim();
    const status     = parts[2]?.trim().toUpperCase() || "PENDING";
    if (!promiseTracker.has(politician)) promiseTracker.set(politician, []);
    promiseTracker.get(politician).push({ promise, status, date: new Date().toISOString().slice(0, 10) });
    await sendText(from, `Promise added for ${politician}: "${promise}" — ${status}`);
    return true;
  }

  if (upper.startsWith("UPDATE PROMISE ")) {
    const parts = rawText.slice(15).split("|");
    if (parts.length < 3) {
      await sendText(from, "Usage: UPDATE PROMISE [politician] | [index] | [KEPT/BROKEN/PENDING]");
      return true;
    }
    const politician = parts[0].trim().toLowerCase();
    const idx        = parseInt(parts[1].trim()) - 1;
    const newStatus  = parts[2].trim().toUpperCase();
    const promises   = promiseTracker.get(politician);
    if (!promises || !promises[idx]) { await sendText(from, "Promise record not found."); return true; }
    promises[idx].status = newStatus;
    await sendText(from, `Updated: "${promises[idx].promise}" — ${newStatus}`);
    return true;
  }

  // ── Close ticket ──────────────────────────────────────────────────────────
  if (upper.startsWith("CLOSE TICKET ")) {
    const ref = rawText.slice(13).trim();
    await closeTicket(ref);
    await sendText(from, `Ticket ${ref} has been closed.`);
    return true;
  }

  return false;
}
