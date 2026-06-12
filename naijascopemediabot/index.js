import express from "express";
import crypto from "crypto";

import { verifyWebhookSignature, sanitizeInput, isValidPhone, detectImpersonation, detectPromptInjection, detectHarmfulContent } from "./src/middleware/security.js";
import { sendText, markAsRead } from "./src/services/whatsappService.js";
import { sendMainMenu, sendReturnMenu } from "./src/whatsapp/menus.js";
import { sendOnboardingWelcome } from "./src/whatsapp/onboarding.js";
import { upsertUser, getUser } from "./src/utils/db.js";
import { logger, withCorrelationId } from "./src/utils/logger.js";
import { validateStartup } from "./src/utils/startup.js";

import {
  trackMessageId, track,
  tipsInProgress, reportsInProgress,
  awaitingTeamName, awaitingFactCheck, awaitingHandoff,
  onboardingPending,
  checkWindowRateLimit, suspendUser, isUserSuspended,
} from "./src/state/sessionState.js";
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
      if (!trackMessageId(messageId)) return; // dedup

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
          await sendText(from, "✅ Bot reactivated. Welcome back. 🤖");
          await sendMainMenu(from);
        } else {
          await sendText(from, `🎙️ You're connected to our journalist team (Ref: ${openTicket.reference_code}).\n\nReply "menu" to return to the bot.`);
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
        await sendText(from, "We're experiencing a short technical issue. Please send your message again in a moment — we'll be right back. 🙏");
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
        await sendText(from,
          "NaijaScope Media is committed to maintaining a respectful and safe communication environment. " +
          "This conversation has been flagged. Please refer to our community guidelines at www.bayelsamedia.com.ng."
        );
        return;
      }

      // ── 2b. Prompt injection / jailbreak filter ───────────────────────────
      if (detectPromptInjection(rawText)) {
        logger.warn(`[SECURITY] Prompt injection attempt from ${from}`);
        await sendText(from,
          "I'm here to assist with news, information, and media updates from NaijaScope Media. How can I help you today?"
        );
        return;
      }

      // ── 2a. Identity / impersonation claim filter ─────────────────────────
      // Must NOT be an admin — admins are verified by phone number, not text.
      if (!isAdmin(from) && detectImpersonation(rawText)) {
        logger.warn(`[SECURITY] Impersonation attempt from ${from}: ${rawText.slice(0, 80)}`);
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
        await sendText(from, `⚡ Subscribed to ${rawText} alerts! You'll get match updates as they happen. ⚽`);
        return;
      }

      if (awaitingFactCheck.has(from)) {
        awaitingFactCheck.delete(from);
        await sendText(from, "🔍 Checking that claim...");
        await sendText(from, await verifyClaim(rawText));
        return;
      }

      if (awaitingHandoff.has(from)) {
        awaitingHandoff.delete(from);
        await transferToHuman(from, rawText);
        return;
      }

      // ── Admin commands ────────────────────────────────────────────────────
      if (isAdmin(from)) {
        const handled = await handleAdmin(from, rawText);
        if (handled) return;
      }

      // ── Users who received the onboarding picker but typed instead of tapping
      if (onboardingPending.has(from)) {
        await sendText(from, "👆 Tap one of the options above to pick your interest — or type 'menu' to jump straight in!");
        return;
      }

      // ── Smart returning-user experience (away > 24 h) ─────────────────────
      if (userRow?.last_seen) {
        const hoursSince = (Date.now() - new Date(userRow.last_seen).getTime()) / 3_600_000;
        if (hoursSince > 24) {
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
