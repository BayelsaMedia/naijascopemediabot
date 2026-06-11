import { sendText } from "../services/whatsappService.js";
import {
  sendMainMenu, sendSubscriptionMenu, sendLanguageMenu, sendFootballMenu,
} from "../whatsapp/menus.js";
import {
  sendNewsItems, fetchRSSItems, getNewsByCategory,
  fetchOilPrice, fetchExchangeRate, fetchWeather, fetchFloodAlert,
} from "../services/newsService.js";
import { getAIResponse } from "../services/aiService.js";
import { verifyClaim } from "../services/factCheckService.js";
import { subscribeToTeam } from "../services/footballService.js";
import { getSavedArticles } from "../services/articleService.js";
import { addSubscription, removeSubscription, persistKeywordAlert } from "../services/alertService.js";
import { saveLanguagePreference, detectLanguageIntent, LANG_NAMES } from "../services/languageService.js";
import { transferToHuman, isHandoffRequest } from "../services/supportService.js";
import { trackCategoryRead } from "../services/preferenceService.js";
import {
  tipsInProgress, reportsInProgress,
  awaitingTeamName, awaitingFactCheck, awaitingHandoff,
  promiseTracker, checkRateLimit, track,
} from "../state/sessionState.js";
import { getPollResults } from "../jobs/dailyPoll.js";
import { CATEGORY_KEYWORDS, SITE_URL } from "../config/constants.js";
import { logger } from "../utils/logger.js";

const ADMIN_NUMBER = process.env.ADMIN_NUMBER;

// ── Multi-step flows ───────────────────────────────────────────────────────────

export async function runTipFlow(from, text, rawText) {
  const flow = tipsInProgress.get(from);
  if (flow.step === 1) {
    flow.data.about = rawText; flow.step = 2;
    await sendText(from, "📍 Step 2 of 3: Which location does this involve? (City / LGA / Community)");
    return true;
  }
  if (flow.step === 2) {
    flow.data.location = rawText; flow.step = 3;
    await sendText(from, "📎 Step 3 of 3: Any evidence? Send a photo or type 'none'");
    return true;
  }
  if (flow.step === 3) {
    flow.data.evidence = text === "none" ? "No evidence provided" : rawText;
    tipsInProgress.delete(from);
    await sendText(from, "✅ Your tip has been submitted anonymously to NaijaScope Media.\n\nThank you for speaking up. Your identity is fully protected 🔒");
    if (ADMIN_NUMBER) {
      await sendText(ADMIN_NUMBER, `🔔 New Anonymous Tip:\n\nAbout: ${flow.data.about}\nLocation: ${flow.data.location}\nEvidence: ${flow.data.evidence}`);
    }
    return true;
  }
  return false;
}

export async function runReportFlow(from, rawText) {
  const flow = reportsInProgress.get(from);
  if (flow.step === 1) {
    flow.data.what = rawText; flow.step = 2;
    await sendText(from, "📍 Step 2 of 4: Where exactly did this happen? (Location)");
    return true;
  }
  if (flow.step === 2) {
    flow.data.where = rawText; flow.step = 3;
    await sendText(from, "🕐 Step 3 of 4: When did this happen? (Date and time)");
    return true;
  }
  if (flow.step === 3) {
    flow.data.when = rawText; flow.step = 4;
    await sendText(from, "📷 Step 4 of 4: Send a photo if you have one, or type 'none'");
    return true;
  }
  if (flow.step === 4) {
    flow.data.photo = rawText.toLowerCase() === "none" ? "No photo" : "Photo submitted";
    reportsInProgress.delete(from);
    await sendText(from, "✅ Story submitted to the NaijaScope newsroom!\n\nOur journalists will review your report. Thank you for being a citizen journalist 📰🇳🇬");
    if (ADMIN_NUMBER) {
      await sendText(ADMIN_NUMBER, `📰 New Citizen Report:\n\nWhat: ${flow.data.what}\nWhere: ${flow.data.where}\nWhen: ${flow.data.when}\nPhoto: ${flow.data.photo}`);
    }
    return true;
  }
  return false;
}

// ── Promise tracker ────────────────────────────────────────────────────────────
function getPromises(politicianRaw) {
  const name = politicianRaw.toLowerCase().trim();
  for (const [key, promises] of promiseTracker) {
    if (key.includes(name) || name.includes(key)) {
      const lines = promises.map((p, i) => `${i + 1}. [${p.status}] ${p.promise}`).join("\n");
      return `📋 Promise Tracker — ${key}:\n\n${lines}\n\nSource: NaijaScope Media`;
    }
  }
  return `No promise records found for "${politicianRaw}" yet.\n\nType 'help' to explore all features.`;
}

// ── Main text command router ───────────────────────────────────────────────────
export async function handleText(from, text, rawText, userRow) {
  track(from, text.split(" ")[0]);

  if (text === "menu" || text === "help") { await sendMainMenu(from, userRow); return; }

  if (text === "news" || text === "headlines") {
    const items = await fetchRSSItems();
    await sendNewsItems(from, items.slice(0, 5), "📰 Top stories right now:", userRow);
    return;
  }

  if (text === "trending") {
    const items = await fetchRSSItems();
    await sendNewsItems(from, items.slice(0, 3), "🔥 Trending on NaijaScope:", userRow);
    return;
  }

  if (text === "football" || text === "soccer") {
    trackCategoryRead(from, "football").catch(() => {});
    await sendFootballMenu(from);
    return;
  }

  if (text === "contact") {
    await sendText(from, `📞 NaijaScope Media:\n\n🌐 ${SITE_URL}\n📧 admin@bayelsamedia.com.ng\n\nWe'd love to hear from you! 🇳🇬`);
    return;
  }

  if (text === "subscribe") { await sendSubscriptionMenu(from); return; }
  if (text === "unsubscribe") {
    await Promise.all([
      removeSubscription(from, "daily_digest"),
      removeSubscription(from, "breaking_news"),
    ]);
    await sendText(from, "👋 Unsubscribed from all alerts. No wahala!\n\nType 'subscribe' anytime to rejoin.");
    return;
  }

  if (text === "language" || text === "my language") { await sendLanguageMenu(from); return; }
  if (text === "pidgin on")  { await saveLanguagePreference(from, "pidgin"); await sendText(from, "Oya! Pidgin mode don activate 🇳🇬"); return; }
  if (text === "pidgin off") { await saveLanguagePreference(from, "en");     await sendText(from, "Pidgin mode off. Back to English! ✅"); return; }

  if (text === "saved" || text === "my saved" || text === "bookmarks") {
    const saved = await getSavedArticles(from);
    if (saved.length === 0) {
      await sendText(from, "📚 Your reading list is empty.\n\nAfter reading a story, tap 'Save This' to bookmark it!");
    } else {
      const lines = saved.map((a, i) => `${i + 1}. ${a.article_title}\n🔗 ${a.article_url}`).join("\n\n");
      await sendText(from, `🔖 Your saved articles:\n\n${lines}`);
    }
    return;
  }

  if (text === "oil price" || text === "oil price today") { trackCategoryRead(from, "oil").catch(() => {}); await sendText(from, await fetchOilPrice()); return; }
  if (text === "dollar rate" || text === "exchange rate" || text === "naira rate") { await sendText(from, await fetchExchangeRate()); return; }
  if (text === "markets") {
    trackCategoryRead(from, "oil").catch(() => {});
    const [oil, fx] = await Promise.all([fetchOilPrice(), fetchExchangeRate()]);
    await sendText(from, oil);
    await sendText(from, fx);
    return;
  }

  if (text === "flood alert" || text === "flood") { await sendText(from, await fetchFloodAlert()); return; }
  if (text.startsWith("weather ")) {
    const city = rawText.slice(8).trim();
    if (!city) { await sendText(from, "Which city? E.g: weather Yenagoa"); return; }
    await sendText(from, await fetchWeather(city));
    return;
  }

  if (text === "opportunities" || text === "jobs" || text === "scholarships") {
    trackCategoryRead(from, "opportunities").catch(() => {});
    const opps = await getNewsByCategory("opportunities");
    await sendNewsItems(from, opps || [], "🎓 Latest opportunities:", userRow);
    return;
  }

  if (text === "poll") { await sendText(from, getPollResults()); return; }

  if (text.startsWith("fact check ") || text.startsWith("fact-check ")) {
    const claim = rawText.slice(rawText.indexOf(" ", 4) + 1).trim();
    await sendText(from, "🔍 Checking that claim...");
    await sendText(from, await verifyClaim(claim));
    return;
  }
  if (text === "fact check" || text === "verify") {
    awaitingFactCheck.add(from);
    await sendText(from, "🔍 Send me the claim you want fact-checked:");
    return;
  }

  if (isHandoffRequest(text)) {
    awaitingHandoff.set(from, true);
    await sendText(from, "🎙️ Sure! Briefly describe what you'd like to discuss with our journalist team:");
    return;
  }

  if (text === "election" || text === "2027 election") {
    trackCategoryRead(from, "election").catch(() => {});
    await sendNewsItems(from, await getNewsByCategory("election") || [], "🗳️ 2027 Election updates:", userRow);
    return;
  }
  if (text === "nddc") {
    trackCategoryRead(from, "nddc").catch(() => {});
    await sendNewsItems(from, await getNewsByCategory("nddc") || [], "📋 NDDC Tracker:", userRow);
    return;
  }

  if (text.startsWith("promise ")) {
    await sendText(from, getPromises(rawText.slice(8).trim()));
    return;
  }

  if (text.startsWith("alert ")) {
    const kw = rawText.slice(6).trim().toLowerCase();
    if (kw) {
      await persistKeywordAlert(from, kw);
      await sendText(from, `🔔 Alert set for "${kw}". I'll notify you whenever it hits the news!`);
    }
    return;
  }

  if (text === "tip" || text === "send tip") {
    tipsInProgress.set(from, { step: 1, data: {} });
    await sendText(from, "🕵️ Anonymous Tip Submission (3 steps)\n\nStep 1 of 3: What is your tip about?");
    return;
  }

  if (text === "report" || text === "citizen report") {
    reportsInProgress.set(from, { step: 1, data: {} });
    await sendText(from, "📰 Citizen Report (4 steps)\n\nStep 1 of 4: What happened?");
    return;
  }

  // Category shortcuts (politics, oil, crime, etc.)
  if (Object.keys(CATEGORY_KEYWORDS).includes(text)) {
    trackCategoryRead(from, text).catch(() => {});
    await sendNewsItems(from, await getNewsByCategory(text) || [], `📰 Latest ${text} news:`, userRow);
    return;
  }

  // Language intent from natural language
  const langIntent = detectLanguageIntent(text);
  if (langIntent) {
    await saveLanguagePreference(from, langIntent);
    const langName = LANG_NAMES[langIntent] || langIntent;
    await sendText(from, `✅ Language set to ${langName}! News coming your way in ${langName}. 🇳🇬`);
    return;
  }

  // AI fallback
  if (!checkRateLimit(from)) {
    await sendText(from, "Easy now — give me 3 seconds to breathe 😄");
    return;
  }
  const reply = await getAIResponse(from, rawText, userRow);
  await sendText(from, reply);
}
