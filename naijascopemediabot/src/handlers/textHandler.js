import { sendText, sendButtons } from "../services/whatsappService.js";
import {
  sendMainMenu, sendSubscriptionMenu, sendLanguageMenu, sendFootballMenu,
  sendWelcomeMessage, sendPostNewsButtons, sendPostGeneralButtons,
} from "../whatsapp/menus.js";
import {
  sendNewsItems, fetchRSSItems, getNewsByCategory,
  fetchOilPrice, fetchExchangeRate, fetchWeather, fetchFloodAlert,
  categorizeStory,
} from "../services/newsService.js";
import { getAIResponse, getStoryExplainer } from "../services/aiService.js";
import { verifyClaim } from "../services/factCheckService.js";
import { subscribeToTeam } from "../services/footballService.js";
import { saveArticle, getSavedArticles } from "../services/articleService.js";
import { addSubscription, removeSubscription, persistKeywordAlert } from "../services/alertService.js";
import { saveLanguagePreference, detectLanguageIntent, LANG_NAMES } from "../services/languageService.js";
import { transferToHuman, isHandoffRequest } from "../services/supportService.js";
import { trackCategoryRead } from "../services/preferenceService.js";
import {
  tipsInProgress, reportsInProgress,
  awaitingTeamName, awaitingFactCheck, awaitingHandoff,
  promiseTracker, lastSentNews, checkRateLimit, track,
} from "../state/sessionState.js";
import { getPollResults } from "../jobs/dailyPoll.js";
import { CATEGORY_KEYWORDS, CATEGORY_META, SITE_URL } from "../config/constants.js";
import { logger } from "../utils/logger.js";

const ADMIN_NUMBER = process.env.ADMIN_NUMBER;

// ── Multi-step flows ───────────────────────────────────────────────────────────

export async function runTipFlow(from, text, rawText) {
  const flow = tipsInProgress.get(from);
  if (flow.step === 1) {
    flow.data.about = rawText; flow.step = 2;
    await sendText(from, "📍 Step 2 of 3: Which location does this involve? (City / LGA / Community)");
    return;
  }
  if (flow.step === 2) {
    flow.data.location = rawText; flow.step = 3;
    await sendText(from, "📎 Step 3 of 3: Any evidence? Send a photo or type 'none'");
    return;
  }
  if (flow.step === 3) {
    flow.data.evidence = text === "none" ? "No evidence provided" : rawText;
    tipsInProgress.delete(from);
    await sendText(from, "✅ Your tip has been submitted anonymously to NaijaScope Media.\n\nThank you for speaking up. Your identity is fully protected 🔒");
    if (ADMIN_NUMBER) {
      await sendText(ADMIN_NUMBER, `🔔 New Anonymous Tip:\n\nAbout: ${flow.data.about}\nLocation: ${flow.data.location}\nEvidence: ${flow.data.evidence}`);
    }
  }
}

export async function runReportFlow(from, rawText) {
  const flow = reportsInProgress.get(from);
  if (flow.step === 1) {
    flow.data.what = rawText; flow.step = 2;
    await sendText(from, "📍 Step 2 of 4: Where exactly did this happen? (Location)");
    return;
  }
  if (flow.step === 2) {
    flow.data.where = rawText; flow.step = 3;
    await sendText(from, "🕐 Step 3 of 4: When did this happen? (Date and time)");
    return;
  }
  if (flow.step === 3) {
    flow.data.when = rawText; flow.step = 4;
    await sendText(from, "📷 Step 4 of 4: Send a photo if you have one, or type 'none'");
    return;
  }
  if (flow.step === 4) {
    flow.data.photo = rawText.toLowerCase() === "none" ? "No photo" : "Photo submitted";
    reportsInProgress.delete(from);
    await sendText(from, "✅ Story submitted to the NaijaScope newsroom!\n\nOur journalists will review your report. Thank you for being a citizen journalist 📰🇳🇬");
    if (ADMIN_NUMBER) {
      await sendText(ADMIN_NUMBER, `📰 New Citizen Report:\n\nWhat: ${flow.data.what}\nWhere: ${flow.data.where}\nWhen: ${flow.data.when}\nPhoto: ${flow.data.photo}`);
    }
  }
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
  return `No promise records found for "${politicianRaw}" yet.\n\nType 'help' to explore all NaijaScope features.`;
}

// ── Discover / trending experience ────────────────────────────────────────────
async function sendDiscoverCard(from, items, userRow) {
  const counts = {};
  for (const item of items.slice(0, 25)) {
    const title = (item.title || "").toLowerCase();
    for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
      if (kws.some(kw => title.includes(kw.toLowerCase()))) {
        counts[cat] = (counts[cat] || 0) + 1;
        break;
      }
    }
  }

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    await sendNewsItems(from, items.slice(0, 5), null, userRow);
    return;
  }

  const lines = sorted.slice(0, 5).map(([cat, count]) => {
    const { emoji, label } = CATEGORY_META[cat] || { emoji: "📰", label: cat };
    return `${emoji} ${label} — ${count} ${count === 1 ? "story" : "stories"}`;
  });

  await sendText(from, `🔎 What's making noise in Nigeria right now:\n\n${lines.join("\n")}\n\nWhat would you like to dive into?`);

  const top3 = sorted.slice(0, 3);
  const buttons = top3.map(([cat]) => {
    const { emoji, label } = CATEGORY_META[cat] || { emoji: "📰", label: cat };
    return { id: `cat_${cat}`, title: `${emoji} ${label}`.slice(0, 20) };
  });

  await sendButtons(from, "Choose a theme to explore:", buttons);
}

// ── Greeting detection ────────────────────────────────────────────────────────
const GREETINGS = new Set([
  "hi", "hello", "hey", "start", "hiya", "howdy", "yo",
  "good morning", "good afternoon", "good evening",
  "morning", "afternoon", "evening", "greetings", "sup",
]);

// ── Main text command router ───────────────────────────────────────────────────
export async function handleText(from, text, rawText, userRow) {
  track(from, text.split(" ")[0]);

  // ── 3a. Greeting → Welcome message ───────────────────────────────────────────
  if (GREETINGS.has(text)) { await sendWelcomeMessage(from); return; }

  // ── Navigation ───────────────────────────────────────────────────────────────
  if (text === "menu" || text === "help") { await sendMainMenu(from, userRow); return; }

  // ── News ─────────────────────────────────────────────────────────────────────
  if (text === "news" || text === "headlines" || text === "top") {
    const items = await fetchRSSItems();
    await sendNewsItems(from, items.slice(0, 5), null, userRow);
    await sendPostNewsButtons(from);
    return;
  }

  if (text === "trending" || text === "hot") {
    const items = await fetchRSSItems();
    await sendNewsItems(from, items.slice(0, 3), "🔥 Trending on NaijaScope:", userRow);
    await sendPostNewsButtons(from);
    return;
  }

  if (text === "discover" || text === "what's happening" || text === "explore") {
    const items = await fetchRSSItems();
    await sendDiscoverCard(from, items, userRow);
    return;
  }

  // ── Category shortcuts triggered by dynamic discover buttons ─────────────────
  if (text.startsWith("cat_")) {
    const category = text.replace("cat_", "");
    trackCategoryRead(from, category).catch(() => {});
    const catItems = await getNewsByCategory(category);
    const { emoji, label } = CATEGORY_META[category] || { emoji: "📰", label: category };
    await sendNewsItems(from, catItems, `${emoji} ${label} News:`, userRow);
    return;
  }

  // ── Post-article text shortcuts ───────────────────────────────────────────────
  if (text === "why" || text === "why this matters" || text === "context") {
    const recent = lastSentNews.get(from);
    if (recent?.[0]) {
      await sendText(from, "💡 Generating context...");
      await sendText(from, await getStoryExplainer(recent[0].title));
    } else {
      await sendText(from, "Read a story first, then type 'why' for the context behind it! 👇");
    }
    return;
  }

  if (text === "save" || text === "bookmark") {
    const recent = lastSentNews.get(from);
    if (recent?.[0]) {
      await saveArticle(from, recent[0]);
      await sendText(from, "🔖 Saved! Type 'saved' anytime to revisit your reading list.");
    } else {
      await sendText(from, "Read a story first and then save it! 👇");
    }
    return;
  }

  if (text === "saved" || text === "my saved" || text === "bookmarks") {
    const saved = await getSavedArticles(from);
    if (saved.length === 0) {
      await sendText(from, "📚 Your reading list is empty.\n\nAfter reading a story, type 'save' or tap 'Save This'!");
    } else {
      const lines = saved.map((a, i) => `${i + 1}. ${a.article_title}\n🔗 ${a.article_url}`).join("\n\n");
      await sendText(from, `🔖 Your saved articles:\n\n${lines}`);
    }
    return;
  }

  // ── Football ──────────────────────────────────────────────────────────────────
  if (text === "football" || text === "soccer" || text === "sports") {
    trackCategoryRead(from, "sports").catch(() => {});
    await sendFootballMenu(from);
    return;
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────────
  if (text === "subscribe") { await sendSubscriptionMenu(from); return; }
  if (text === "unsubscribe") {
    await Promise.all([
      removeSubscription(from, "daily_digest"),
      removeSubscription(from, "breaking_news"),
    ]);
    await sendText(from, "👋 Unsubscribed from all alerts. No wahala!\n\nType 'subscribe' anytime to rejoin 📡");
    return;
  }

  // ── Language ──────────────────────────────────────────────────────────────────
  if (text === "language" || text === "my language") { await sendLanguageMenu(from); return; }
  if (text === "pidgin on")  { await saveLanguagePreference(from, "pidgin"); await sendText(from, "Oya! Pidgin mode don activate 🇳🇬"); return; }
  if (text === "pidgin off") { await saveLanguagePreference(from, "en");     await sendText(from, "Pidgin mode off. Back to English ✅"); return; }

  // ── Markets ───────────────────────────────────────────────────────────────────
  if (text === "oil" || text === "oil price" || text === "oil today") {
    trackCategoryRead(from, "oil").catch(() => {});
    await sendText(from, await fetchOilPrice());
    return;
  }
  if (text === "dollar" || text === "naira" || text === "exchange rate" || text === "dollar rate") {
    await sendText(from, await fetchExchangeRate());
    return;
  }
  if (text === "markets") {
    trackCategoryRead(from, "oil").catch(() => {});
    const [oil, fx] = await Promise.all([fetchOilPrice(), fetchExchangeRate()]);
    await sendText(from, oil);
    await sendText(from, fx);
    return;
  }

  // ── Weather & environment ─────────────────────────────────────────────────────
  if (text === "flood" || text === "flood alert") {
    await sendText(from, await fetchFloodAlert());
    return;
  }
  if (text.startsWith("weather ")) {
    const city = rawText.slice(8).trim();
    if (!city) { await sendText(from, "Which city? e.g: weather Yenagoa"); return; }
    await sendText(from, await fetchWeather(city));
    return;
  }

  // ── Opportunities ─────────────────────────────────────────────────────────────
  if (["opportunities", "jobs", "scholarships", "grants"].includes(text)) {
    trackCategoryRead(from, "opportunities").catch(() => {});
    await sendNewsItems(from, await getNewsByCategory("opportunities"), "🎓 Latest opportunities:", userRow);
    return;
  }

  // ── Community ─────────────────────────────────────────────────────────────────
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

  // ── NaijaScope beats ──────────────────────────────────────────────────────────
  if (text === "election" || text === "2027" || text === "2027 election") {
    trackCategoryRead(from, "election").catch(() => {});
    await sendNewsItems(from, await getNewsByCategory("election"), "🗳️ 2027 Election coverage:", userRow);
    return;
  }
  if (text === "nddc") {
    trackCategoryRead(from, "nddc").catch(() => {});
    await sendNewsItems(from, await getNewsByCategory("nddc"), "📋 NDDC Tracker:", userRow);
    return;
  }
  if (text === "contact") {
    await sendText(from, `📞 NaijaScope Media:\n\n🌐 ${SITE_URL}\n📧 admin@bayelsamedia.com.ng\n\nWe'd love to hear from you 🇳🇬`);
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
      await sendText(from, `🔔 Alert set for "${kw}"!\n\nI'll notify you the moment it hits the news. 📡`);
    }
    return;
  }

  if (text === "tip" || text === "send tip") {
    tipsInProgress.set(from, { step: 1, data: {} });
    await sendText(from, "🕵️ Anonymous Tip Submission (3 steps)\n\nYour identity will never be revealed.\n\nStep 1 of 3: What is your tip about?");
    return;
  }

  if (text === "report" || text === "citizen report") {
    reportsInProgress.set(from, { step: 1, data: {} });
    await sendText(from, "📰 Citizen Report (4 steps)\n\nYour report goes directly to our newsroom.\n\nStep 1 of 4: What happened?");
    return;
  }

  // ── Category shortcuts ────────────────────────────────────────────────────────
  if (Object.keys(CATEGORY_KEYWORDS).includes(text)) {
    trackCategoryRead(from, text).catch(() => {});
    const { emoji, label } = CATEGORY_META[text] || { emoji: "📰", label: text };
    await sendNewsItems(from, await getNewsByCategory(text), `${emoji} Latest ${label} news:`, userRow);
    return;
  }

  // ── Language intent ───────────────────────────────────────────────────────────
  const langIntent = detectLanguageIntent(text);
  if (langIntent) {
    await saveLanguagePreference(from, langIntent);
    const langName = LANG_NAMES[langIntent] || langIntent;
    await sendText(from, `✅ Language set to ${langName}! News coming your way in ${langName} 🇳🇬`);
    return;
  }

  // ── AI fallback ───────────────────────────────────────────────────────────────
  if (!checkRateLimit(from)) {
    await sendText(from, "Easy now — give me 3 seconds to breathe 😄");
    return;
  }
  const reply = await getAIResponse(from, rawText, userRow);
  await sendText(from, reply);
  // 3b. Option B navigation buttons after every AI/general response
  await sendPostGeneralButtons(from);
}
