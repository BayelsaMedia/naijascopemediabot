import express from "express";
import crypto from "crypto";

import { verifyWebhookSignature, sanitizeInput, isValidPhone, detectImpersonation, detectPromptInjection, detectHarmfulContent } from "./src/middleware/security.js";
import { sendText, markAsRead } from "./src/services/whatsappService.js";
import { sendMainMenu, sendReturnMenu } from "./src/whatsapp/menus.js";
import { sendOnboardingWelcome } from "./src/whatsapp/onboarding.js";
import { upsertUser, getUser, setOptedOut } from "./src/utils/db.js";
import { logger, withCorrelationId } from "./src/utils/logger.js";
import { validateStartup } from "./src/utils/startup.js";

import {
  trackMessageId, track,
  tipsInProgress, reportsInProgress,
  awaitingTeamName, awaitingFactCheck, awaitingHandoff,
  onboardingPending,
  checkWindowRateLimit, suspendUser, isUserSuspended,
  isOptedOut, markOptedOut, clearOptedOut,
  searchSessions, botMetrics,
} from "./src/state/sessionState.js";
import { runSearchFlow } from "./src/services/searchService.js";
import { logSecurityEvent, recordSuspension } from "./src/admin/securityLog.js";
import { startHealthMetricsJob } from "./src/jobs/healthMetricsJob.js";
import { handleInteractive } from "./src/handlers/interactiveHandler.js";
import { handleText, runTipFlow, runReportFlow } from "./src/handlers/textHandler.js";
import { handleMedia } from "./src/handlers/mediaHandler.js";
import { handleAdmin, isAdmin } from "./src/handlers/adminHandler.js";

import { fetchRSSItems } from "./src/services/newsService.js";
import { getOpenTicket, closeTicket, transferToHuman } from "./src/services/supportService.js";
import { subscribeToTeam } from "./src/services/footballService.js";
import { verifyClaim } from "./src/services/factCheckService.js";
import { incrementMessageCount, detectTopCategories, countNewStoriesSince } from "./src/services/preferenceService.js";

import { startDailyBriefingJob } from "./src/jobs/dailyBriefing.js";
import { startDailyPollJob } from "./src/jobs/dailyPoll.js";
import { startBreakingNewsMonitor } from "./src/jobs/breakingNewsMonitor.js";
import { startEveningWrapUpJob } from "./src/jobs/eveningWrapUp.js";
import { startScheduledBroadcastJob } from "./src/jobs/scheduledBroadcastJob.js";
import { recordProbeAttempt, getAdminNumbers } from "./src/admin/adminAudit.js";

const app = express();

// ── Body parsing — store raw buffer for HMAC verification ─────────────────────
// The verify callback stores the raw body without throwing.
// Signature check is done in the route itself so we control the exact response.
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

// ── Health & keep-alive endpoints ──────────────────────────────────────────────
app.get("/",       (_req, res) => res.status(200).json({ status: "ok", service: "NaijaScope Media Bot", version: "2.0.0" }));
app.get("/health", (_req, res) => res.status(200).json({ status: "ok", ts: new Date().toISOString() }));

// ── Meta webhook verification (GET) ───────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    logger.info("[WEBHOOK] Verified by Meta");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── Webhook handler (POST) ────────────────────────────────────────────────────
app.post("/webhook", (req, res) => {
  // Signature check — returns false on failure, undefined when skipped (dev mode)
  const sigResult = verifyWebhookSignature(req);
  if (sigResult === false) {
    logger.warn("[WEBHOOK] Rejected — invalid or missing signature");
    return res.status(401).json({ error: "Invalid or missing webhook signature" });
  }

  res.sendStatus(200); // respond immediately; all processing is async

  const reqId = crypto.randomBytes(4).toString("hex");
  withCorrelationId(reqId, async () => {
    try {
      const body = req.body;
      if (!body || body.object !== "whatsapp_business_account") return;

      const value = body.entry?.[0]?.changes?.[0]?.value;
      if (!value) return;

      // Skip delivery / read status updates — they carry `statuses`, not `messages`
      if (value.statuses && !value.messages) return;

      const message = value.messages?.[0];
      if (!message) return;

      const from      = message.from;
      const messageId = message.id;
      if (!from || !messageId || !isValidPhone(from)) return;
      if (!trackMessageId(messageId)) { botMetrics.duplicatesBlockedToday++; return; } // dedup (Section 7.1)

      // ── Section 7.3: Group message filtering ─────────────────────────────
      // Group JIDs in WhatsApp Cloud API end with @g.us or contain a group indicator.
      // Only respond to group messages that begin with a known trigger keyword.
      const isGroupMessage = from.includes("@g.us") || message.context?.group_id != null;
      if (isGroupMessage) {
        const bodyLower = (message.text?.body || "").trim().toLowerCase();
        const TRIGGER_WORDS = ["news", "menu", "help", "headlines", "football", "markets", "subscribe"];
        if (!TRIGGER_WORDS.some(w => bodyLower.startsWith(w))) {
          logger.info(`[GROUP] Ignored group message from ${from} — no trigger keyword`);
          return;
        }
      }

      await markAsRead(messageId);

      // ── 2f. Suspended users — silently drop all messages ─────────────────
      if (isUserSuspended(from)) {
        logger.info(`[SECURITY] Dropped message from suspended user: ${from}`);
        return;
      }

      // ── 2d. Sliding-window rate limit (20 responses / 10 min) ────────────
      const windowResult = checkWindowRateLimit(from);
      if (windowResult === "warn") {
        await sendText(from, "You have sent an unusually high number of messages. Please wait a few minutes before continuing.");
        return;
      }
      if (windowResult === false) {
        return; // silently drop — warning already sent
      }

      track(from, null);
      botMetrics.webhookEventsToday++;
      incrementMessageCount(from).catch(() => {});
      logger.info(`[MSG] from=${from} type=${message.type}`);

      // ── Journalist handoff check ──────────────────────────────────────────
      // Wrapped in try/catch — a missing support_tickets table must not block everyone.
      let openTicket = null;
      try {
        openTicket = await getOpenTicket(from);
      } catch (err) {
        logger.warn("[WEBHOOK] getOpenTicket failed (non-fatal):", err.message);
      }

      if (openTicket && message.type === "text") {
        const txt = message.text?.body?.trim().toLowerCase() || "";
        if (txt === "menu" || txt === "resume" || txt === "bot") {
          await closeTicket(openTicket.reference_code);
          await sendText(from, "Your session has been returned to the NaijaScope Media Intelligence Bot. Welcome back.");
          await sendMainMenu(from);
        } else {
          await sendText(from, `You are currently connected to the NaijaScope Media journalist team (Reference: ${openTicket.reference_code}).\n\nReply "menu" to return to the automated service.`);
        }
        return;
      }

      // ── Database — wrapped so DB outages never silence the bot ────────────
      let existingUser = null;
      let userRow      = null;
      let dbAvailable  = true;

      try {
        existingUser = await getUser(from);
        userRow      = await upsertUser(from);
      } catch (err) {
        logger.error("[WEBHOOK] DB error for", from, "—", err.message);
        dbAvailable = false;
      }

      // ── Section 7.9: Opt-out / re-engagement handling ────────────────────
      // In-memory cache is the fast path; DB persists across restarts.
      if (message.type === "text") {
        const bodyRaw   = (message.text?.body || "").trim();
        const bodyLow   = bodyRaw.toLowerCase();

        const OPT_OUT_TRIGGERS  = ["stop", "unsubscribe", "opt out", "opt-out", "remove me"];
        const RE_ENGAGE_TRIGGERS = ["start", "hi", "hello", "hey"];

        // Check in-memory cache first (fast path)
        const currentlyOptedOut = isOptedOut(from) || existingUser?.opted_out;

        if (currentlyOptedOut) {
          if (RE_ENGAGE_TRIGGERS.some(t => bodyLow === t || bodyLow.startsWith(t + " "))) {
            // User wishes to re-engage
            clearOptedOut(from);
            try { await setOptedOut(from, false); } catch (_) {}
            await sendText(from, "Welcome back to NaijaScope Media. Your subscription has been reactivated. You will receive news briefings and alerts as normal.");
            await sendOnboardingWelcome(from);
          } else {
            // User is opted out and this is not a re-engage message — drop silently
            logger.info(`[OPT-OUT] Dropped message from opted-out user: ${from}`);
          }
          return;
        }

        if (OPT_OUT_TRIGGERS.some(t => bodyLow === t || bodyLow.startsWith(t + " "))) {
          markOptedOut(from);
          try {
            await setOptedOut(from, true);
            // Remove all subscriptions
            const { removeSubscription } = await import("./src/services/alertService.js");
            await removeSubscription(from, "daily_digest").catch(() => {});
            await removeSubscription(from, "breaking_news").catch(() => {});
            await removeSubscription(from, "opportunities").catch(() => {});
          } catch (_) {}
          await sendText(from, "You have been unsubscribed from all NaijaScope Media communications. No further messages will be sent to you.\n\nTo re-subscribe at any time, simply send 'Start' or 'Hi'.");
          return;
        }
      }

      // ── New user: send onboarding immediately, before any other routing ────
      // This check is here — before the interactive/media/text branches — so that
      // a new user's very first message (of any type) always triggers the welcome.
      if (dbAvailable && !existingUser && !onboardingPending.has(from)) {
        onboardingPending.add(from);
        await sendOnboardingWelcome(from);
        return;
      }

      // ── DB completely down — give a friendly retry notice ─────────────────
      if (!dbAvailable) {
        await sendText(from, "NaijaScope Media is experiencing a brief technical interruption. Please resend your message in a moment and service will resume shortly.");
        return;
      }

      // ── Interactive (button / list) replies ──────────────────────────────
      if (message.type === "interactive") {
        const replyId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
        await handleInteractive(from, replyId, userRow);
        return;
      }

      // ── Non-text media ────────────────────────────────────────────────────
      if (message.type !== "text") {
        await handleMedia(from, message, userRow);
        return;
      }

      if (!message.text?.body) return;
      const rawText = sanitizeInput(message.text.body, 2_000);
      if (!rawText) return;
      const text = rawText.toLowerCase().trim();

      // ── 2f. Harmful content filter ────────────────────────────────────────
      if (detectHarmfulContent(rawText)) {
        logger.warn(`[SECURITY] Harmful content detected from ${from} — suspending 24h`);
        suspendUser(from);
        recordSuspension(from, "harmful", rawText.slice(0, 60));
        await sendText(from,
          "NaijaScope Media is committed to maintaining a respectful and safe communication environment. " +
          "This conversation has been flagged. Please refer to our community guidelines at www.bayelsamedia.com.ng."
        );
        return;
      }

      // ── 2b. Prompt injection / jailbreak filter ───────────────────────────
      if (detectPromptInjection(rawText)) {
        logger.warn(`[SECURITY] Prompt injection attempt from ${from}`);
        logSecurityEvent(from, "injection", rawText.slice(0, 200)).catch(() => {});
        await sendText(from,
          "I am the NaijaScope Media Intelligence Bot. I am here to provide news intelligence and assist with NaijaScope Media's content. How may I assist you today?"
        );
        return;
      }

      // ── 2a. Identity / impersonation claim filter ─────────────────────────
      // Must NOT be an admin — admins are verified by phone number, not text.
      if (!isAdmin(from) && detectImpersonation(rawText)) {
        logger.warn(`[SECURITY] Impersonation attempt from ${from}: ${rawText.slice(0, 80)}`);
        logSecurityEvent(from, "impersonation", rawText.slice(0, 200)).catch(() => {});
        await sendText(from,
          "Thank you for reaching out to NaijaScope Media. For verified staff communication, all internal " +
          "operations are conducted through official channels. This chatbot is a public-facing service and " +
          "cannot process identity verification requests. Please visit www.bayelsamedia.com.ng for contact details."
        );
        return;
      }

      // ── Active multi-step flows ───────────────────────────────────────────
      if (tipsInProgress.has(from))    { await runTipFlow(from, text, rawText);  return; }
      if (reportsInProgress.has(from)) { await runReportFlow(from, rawText);     return; }

      if (awaitingTeamName.has(from)) {
        awaitingTeamName.delete(from);
        await subscribeToTeam(from, rawText);
        await sendText(from, `You have been subscribed to ${rawText} alerts. NaijaScope Media will notify you of relevant match updates as they occur.`);
        return;
      }

      if (awaitingFactCheck.has(from)) {
        awaitingFactCheck.delete(from);
        await sendText(from, "NaijaScope Fact-Check: Verifying that claim. Please wait.");
        await sendText(from, await verifyClaim(rawText));
        return;
      }

      if (awaitingHandoff.has(from)) {
        awaitingHandoff.delete(from);
        await transferToHuman(from, rawText);
        return;
      }

      // ── Module B: Search session check ───────────────────────────────────
      if (searchSessions.has(from) && searchSessions.get(from)?.step === "awaiting_keyword") {
        await runSearchFlow(from, rawText, userRow);
        return;
      }

      // ── Admin commands ────────────────────────────────────────────────────
      if (isAdmin(from)) {
        const handled = await handleAdmin(from, rawText);
        if (handled) return;
      }

      // ── A1: Non-admin command interception ────────────────────────────────
      // Commands starting with /admin, /broadcast, /breaking, /promise, or
      // /subscribers are admin-only. Non-admins get the main menu silently;
      // we do not reveal that these commands exist.
      if (!isAdmin(from) && /^\/(admin|broadcast|breaking|promise|subscribers|stats|unsuspend|trending)\b/i.test(rawText.trim())) {
        await recordProbeAttempt(from);
        await sendMainMenu(from, userRow);
        return;
      }

      // ── Users who received the onboarding picker but typed instead of tapping
      if (onboardingPending.has(from)) {
        await sendText(from, "Please select one of the options above to set your news interest, or type 'menu' to proceed directly to the main service.");
        return;
      }

      // ── Section 7.7: Session timeout — re-engagement after 12h absence ──────
      if (userRow?.last_seen) {
        const hoursSince = (Date.now() - new Date(userRow.last_seen).getTime()) / 3_600_000;
        if (hoursSince > 12) {
          const items    = await fetchRSSItems();
          const newCount = countNewStoriesSince(items, userRow.last_seen);
          const topCats  = detectTopCategories(items.slice(0, 15));
          await sendReturnMenu(from, newCount, topCats);
          return;
        }
      }

      // ── Text commands + AI fallback ───────────────────────────────────────
      await handleText(from, text, rawText, userRow);

    } catch (err) {
      logger.error("[WEBHOOK] Unhandled error:", err.message, err.stack);
    }
  }).catch(err => logger.error("[WEBHOOK] Fatal async error:", err.message));
});

// ── Server startup ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function start() {
  await validateStartup();

  const server = app.listen(PORT, () => {
    logger.info(`✅ NaijaScope Media Bot v2.0 running on port ${PORT}`);
    startDailyBriefingJob(fetchRSSItems);
    startDailyPollJob();
    startBreakingNewsMonitor(fetchRSSItems);
    startEveningWrapUpJob(fetchRSSItems);
    startScheduledBroadcastJob(); // A2: dispatch scheduled + resume interrupted broadcasts
    startHealthMetricsJob();      // C: health metrics snapshot every 5 minutes
  });

  const shutdown = (signal) => {
    logger.info(`[SHUTDOWN] ${signal} received — shutting down gracefully`);
    server.close(() => {
      logger.info("[SHUTDOWN] HTTP server closed");
      process.exit(0);
    });
    setTimeout(() => {
      logger.error("[SHUTDOWN] Forced exit after 10s timeout");
      process.exit(1);
    }, 10_000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("uncaughtException",  (err)    => logger.error("[UNCAUGHT]", err.message, err.stack));
  process.on("unhandledRejection", (reason) => logger.error("[UNHANDLED REJECTION]", String(reason)));
}

start();
