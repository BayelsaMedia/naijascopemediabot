import express from "express";
import crypto from "crypto";

import { verifyWebhookSignature, sanitizeInput, isValidPhone } from "./src/middleware/security.js";
import { sendText, markAsRead } from "./src/services/whatsappService.js";
import { sendWelcomeMessage, sendMainMenu, sendReturnMenu } from "./src/whatsapp/menus.js";
import { upsertUser, getUser } from "./src/utils/db.js";
import { logger, withCorrelationId } from "./src/utils/logger.js";
import { validateStartup } from "./src/utils/startup.js";

import { trackMessageId, track, tipsInProgress, reportsInProgress, awaitingTeamName, awaitingFactCheck, awaitingHandoff } from "./src/state/sessionState.js";
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

app.use(express.json({
  verify: (req, res, buf) => {
    if (req.path === "/webhook" && req.method === "POST") {
      verifyWebhookSignature(req, res, buf);
    }
  },
}));

// ── Health & verification ──────────────────────────────────────────────────────
app.get("/",       (_req, res) => res.status(200).json({ status: "ok", service: "NaijaScope Media Bot", version: "2.0.0" }));
app.get("/health", (_req, res) => res.status(200).json({ status: "ok", ts: new Date().toISOString() }));

app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    logger.info("[WEBHOOK] Verified by Meta");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── Webhook handler ───────────────────────────────────────────────────────────
app.post("/webhook", (req, res) => {
  res.sendStatus(200); // respond immediately; all processing is async

  const reqId = crypto.randomBytes(4).toString("hex");
  withCorrelationId(reqId, async () => {
    try {
      const body    = req.body;
      if (!body || body.object !== "whatsapp_business_account") return;
      const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!message) return;

      const from      = message.from;
      const messageId = message.id;
      if (!from || !messageId || !isValidPhone(from)) return;
      if (!trackMessageId(messageId)) return; // dedup

      await markAsRead(messageId);
      track(from, null);
      incrementMessageCount(from).catch(() => {});
      logger.info(`[MSG] from=${from} type=${message.type}`);

      // Check if user has an open support ticket (bot paused)
      const openTicket = await getOpenTicket(from);
      if (openTicket && message.type === "text") {
        const txt = message.text?.body?.trim().toLowerCase() || "";
        if (txt === "menu" || txt === "resume" || txt === "bot") {
          await closeTicket(openTicket.reference_code);
          await sendText(from, "✅ Bot reactivated! Welcome back. 🤖");
          await sendMainMenu(from);
        } else {
          await sendText(from, `🎙️ You're connected to our journalist team (Ref: ${openTicket.reference_code}).\n\nReply "menu" to return to the bot.`);
        }
        return;
      }

      // Detect new vs returning user before upsert
      const existingUser = await getUser(from);
      const userRow      = await upsertUser(from);

      // ── Interactive (button / list) replies ──────────────────────────────────
      if (message.type === "interactive") {
        const replyId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
        await handleInteractive(from, replyId, userRow);
        return;
      }

      // ── Non-text media (location, image, audio) ──────────────────────────────
      if (message.type !== "text") {
        await handleMedia(from, message, userRow);
        return;
      }

      if (!message.text?.body) return;
      const rawText = sanitizeInput(message.text.body, 2_000);
      if (!rawText) return;
      const text = rawText.toLowerCase().trim();

      // ── Active multi-step flows ──────────────────────────────────────────────
      if (tipsInProgress.has(from))    { await runTipFlow(from, text, rawText);  return; }
      if (reportsInProgress.has(from)) { await runReportFlow(from, rawText);     return; }

      if (awaitingTeamName.has(from)) {
        awaitingTeamName.delete(from);
        await subscribeToTeam(from, rawText);
        await sendText(from, `⚡ Subscribed to ${rawText} alerts! I'll notify you of match updates. ⚽`);
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

      // ── Admin commands ───────────────────────────────────────────────────────
      if (isAdmin(from)) {
        const handled = await handleAdmin(from, rawText);
        if (handled) return;
      }

      // ── First-time user onboarding ───────────────────────────────────────────
      if (!existingUser) {
        await sendWelcomeMessage(from);
        return;
      }

      // ── Smart returning-user experience (away > 24 h) ────────────────────────
      if (userRow?.last_seen) {
        const hoursSince = (Date.now() - new Date(userRow.last_seen).getTime()) / 3_600_000;
        if (hoursSince > 24) {
          const items        = await fetchRSSItems();
          const newCount     = countNewStoriesSince(items, userRow.last_seen);
          const topCats      = detectTopCategories(items.slice(0, 15));
          await sendReturnMenu(from, newCount, topCats);
          return;
        }
      }

      // ── Text commands + AI fallback ──────────────────────────────────────────
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
