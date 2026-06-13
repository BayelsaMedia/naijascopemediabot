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
  promiseTracker, lastSentNews, checkRateLimit, track, botMetrics,
} from "../state/sessionState.js";
import { startSearch, performSearch, sendSearchHistory } from "../services/searchService.js";
import { getPollResults } from "../jobs/dailyPoll.js";
import { CATEGORY_KEYWORDS, CATEGORY_META, SITE_URL } from "../config/constants.js";
import { logger } from "../utils/logger.js";

const ADMIN_NUMBER = process.env.ADMIN_NUMBER;

// ── Multi-step flows ───────────────────────────────────────────────────────────

export async function runTipFlow(from, text, rawText) {
  const flow = tipsInProgress.get(from);
  if (flow.step === 1) {
    flow.data.about = rawText; flow.step = 2;
    await sendText(from, "Step 2 of 3: Which location does this involve? Please provide the city, Local Government Area, or community name.");
    return;
  }
  if (flow.step === 2) {
    flow.data.location = rawText; flow.step = 3;
    await sendText(from, "Step 3 of 3: Do you have any supporting evidence? Send a photograph or type 'none' to proceed without one.");
    return;
  }
  if (flow.step === 3) {
    flow.data.evidence = text === "none" ? "No evidence provided" : rawText;
    tipsInProgress.delete(from);
    await sendText(from, "Your tip has been submitted anonymously to NaijaScope Media. Your identity is fully protected. Thank you for contributing to responsible journalism.");
    if (ADMIN_NUMBER) {
      await sendText(ADMIN_NUMBER, `NaijaScope — New Anonymous Tip\n\nSubject: ${flow.data.about}\nLocation: ${flow.data.location}\nEvidence: ${flow.data.evidence}`);
    }
  }
}

export async function runReportFlow(from, rawText) {
  const flow = reportsInProgress.get(from);
  if (flow.step === 1) {
    flow.data.what = rawText; flow.step = 2;
    await sendText(from, "Step 2 of 4: Where did this occur? Please provide the specific location — city, community, or Local Government Area.");
    return;
  }
  if (flow.step === 2) {
    flow.data.where = rawText; flow.step = 3;
    await sendText(from, "Step 3 of 4: When did this happen? Please provide the date and time, as accurately as possible.");
    return;
  }
  if (flow.step === 3) {
    flow.data.when = rawText; flow.step = 4;
    await sendText(from, "Step 4 of 4: Do you have a photograph? Send one now, or type 'none' to complete your submission without one.");
    return;
  }
  if (flow.step === 4) {
    flow.data.photo = rawText.toLowerCase() === "none" ? "No photograph" : "Photograph submitted";
    reportsInProgress.delete(from);
    await sendText(from, "Your report has been submitted to the NaijaScope Media newsroom. Our journalists will review it and follow up as appropriate. Thank you for your contribution.");
    if (ADMIN_NUMBER) {
      await sendText(ADMIN_NUMBER, `NaijaScope — New Citizen Report\n\nWhat: ${flow.data.what}\nWhere: ${flow.data.where}\nWhen: ${flow.data.when}\nPhotograph: ${flow.data.photo}`);
    }
  }
}

// ── Promise tracker ────────────────────────────────────────────────────────────
function getPromises(politicianRaw) {
  const name = politicianRaw.toLowerCase().trim();
  for (const [key, promises] of promiseTracker) {
    if (key.includes(name) || name.includes(key)) {
      const lines = promises.map((p, i) => `${i + 1}. [${p.status}] ${p.promise}`).join("\n");
      return `NaijaScope Media — Promise Tracker: ${key}\n\n${lines}\n\nSource: NaijaScope Media`;
    }
  }
  return `No promise records are currently available for "${politicianRaw}" in the NaijaScope Media database. Type 'menu' to explore all available services.`;
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

  await sendText(from, `NaijaScope Media — Current Coverage Analysis:\n\n${lines.join("\n")}\n\nSelect a category below to read the latest stories.`);

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

  // ── B1: Search entry points — text triggers ───────────────────────────────
  const SEARCH_TRIGGERS = new Set(["search", "find", "look up", "search news", "find news"]);
  if (SEARCH_TRIGGERS.has(text)) {
    await startSearch(from);
    return;
  }
  if (text.startsWith("/search ")) {
    const kw = rawText.slice(8).trim();
    if (kw) await performSearch(from, kw, userRow);
    else    await startSearch(from);
    return;
  }
  if (text === "/mysearches" || text === "my searches" || text === "search history") {
    await sendSearchHistory(from, userRow);
    return;
  }

  // ── News ─────────────────────────────────────────────────────────────────────
  if (text === "news" || text === "headlines" || text === "top") {
    const items = await fetchRSSItems();
    await sendNewsItems(from, items.slice(0, 5), null, userRow);
    await sendPostNewsButtons(from);
    return;
  }

  if (text === "trending" || text === "hot") {
    const items = await fetchRSSItems();
    await sendNewsItems(from, items.slice(0, 3), "NaijaScope — Most Active Stories:", userRow);
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
      await sendText(from, "Generating editorial context. Please wait.");
      await sendText(from, await getStoryExplainer(recent[0].title));
    } else {
      await sendText(from, "Please read a story first. Type 'news' to see the latest headlines, then use 'why' to receive editorial context on the most recent story.");
    }
    return;
  }

  if (text === "save" || text === "bookmark") {
    const recent = lastSentNews.get(from);
    if (recent?.[0]) {
      await saveArticle(from, recent[0]);
      await sendText(from, "The article has been saved to your reading list. Type 'saved' at any time to access your bookmarks.");
    } else {
      await sendText(from, "Please read a story first before saving it. Type 'news' to view the latest headlines.");
    }
    return;
  }

  if (text === "saved" || text === "my saved" || text === "bookmarks") {
    const saved = await getSavedArticles(from);
    if (saved.length === 0) {
      await sendText(from, "Your reading list is currently empty. After reading a story, type 'save' or tap 'Save This' to add it to your bookmarks.");
    } else {
      const lines = saved.map((a, i) => `${i + 1}. ${a.article_title}\n${a.article_url}`).join("\n\n");
      await sendText(from, `NaijaScope Media — Your Saved Articles:\n\n${lines}`);
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
    await sendText(from, "You have been unsubscribed from all NaijaScope Media alerts. Type 'subscribe' at any time to re-enrol.");
    return;
  }

  // ── Language ──────────────────────────────────────────────────────────────────
  if (text === "language" || text === "my language") { await sendLanguageMenu(from); return; }
  if (text === "pidgin on")  { await saveLanguagePreference(from, "pidgin"); await sendText(from, "Your language preference has been noted. NaijaScope Media responds in formal English by default, with Igbo and Yoruba available on request."); return; }
  if (text === "pidgin off") { await saveLanguagePreference(from, "en");     await sendText(from, "Your language preference has been reset to English."); return; }

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
    if (!city) { await sendText(from, "Please specify a city. For example: weather Yenagoa"); return; }
    await sendText(from, await fetchWeather(city));
    return;
  }

  // ── Opportunities ─────────────────────────────────────────────────────────────
  if (["opportunities", "jobs", "scholarships", "grants"].includes(text)) {
    trackCategoryRead(from, "opportunities").catch(() => {});
    await sendNewsItems(from, await getNewsByCategory("opportunities"), "NaijaScope — Opportunities:", userRow);
    return;
  }

  // ── Community ─────────────────────────────────────────────────────────────────
  if (text === "poll") { await sendText(from, getPollResults()); return; }

  if (text.startsWith("fact check ") || text.startsWith("fact-check ")) {
    const claim = rawText.slice(rawText.indexOf(" ", 4) + 1).trim();
    await sendText(from, "NaijaScope Fact-Check: Verifying that claim. Please wait.");
    await sendText(from, await verifyClaim(claim));
    return;
  }
  if (text === "fact check" || text === "verify") {
    awaitingFactCheck.add(from);
    await sendText(from, "Please send the claim you would like NaijaScope Media to fact-check.");
    return;
  }

  if (isHandoffRequest(text)) {
    awaitingHandoff.set(from, true);
    await sendText(from, "Please briefly describe the matter you would like to discuss with our journalist team. A correspondent will be assigned to your enquiry.");
    return;
  }

  // ── NaijaScope beats ──────────────────────────────────────────────────────────
  if (text === "election" || text === "2027" || text === "2027 election") {
    trackCategoryRead(from, "election").catch(() => {});
    await sendNewsItems(from, await getNewsByCategory("election"), "NaijaScope — 2027 Election Coverage:", userRow);
    return;
  }
  if (text === "nddc") {
    trackCategoryRead(from, "nddc").catch(() => {});
    await sendNewsItems(from, await getNewsByCategory("nddc"), "NaijaScope — NDDC Tracker:", userRow);
    return;
  }
  if (text === "contact") {
    await sendText(from, `NaijaScope Media — Contact Information\n\nWebsite: ${SITE_URL}\nEmail: admin@bayelsamedia.com.ng\n\nFor editorial enquiries, advertising, press releases, or general correspondence, please use the channels above.`);
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
      await sendText(from, `Your keyword alert for "${kw}" has been activated. NaijaScope Media will notify you when this topic appears in the news.`);
    }
    return;
  }

  if (text === "tip" || text === "send tip") {
    tipsInProgress.set(from, { step: 1, data: {} });
    await sendText(from, "NaijaScope Media — Anonymous Tip Submission (3 steps)\n\nYour identity will be fully protected throughout this process.\n\nStep 1 of 3: What is your tip about? Please provide a clear, factual description.");
    return;
  }

  if (text === "report" || text === "citizen report") {
    reportsInProgress.set(from, { step: 1, data: {} });
    await sendText(from, "NaijaScope Media — Citizen Report (4 steps)\n\nYour report will be submitted directly to our newsroom for editorial review.\n\nStep 1 of 4: What happened? Please describe the incident clearly and factually.");
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
    await sendText(from, `Your language preference has been updated to ${langName}. NaijaScope Media will deliver your news in ${langName}.`);
    return;
  }

  // ── AI fallback ───────────────────────────────────────────────────────────────
  if (!checkRateLimit(from)) {
    await sendText(from, "Please allow a moment before sending your next message.");
    return;
  }
  const t0 = Date.now();
  let reply;
  try {
    reply = await getAIResponse(from, rawText, userRow);
    botMetrics.grokSuccessToday++;
  } catch (err) {
    botMetrics.grokFailuresToday++;
    reply = "I am unable to process your request at this time. Please try again in a moment.";
  }
  const elapsed = Date.now() - t0;
  botMetrics.responseTimes.push(elapsed);
  if (botMetrics.responseTimes.length > 100) botMetrics.responseTimes.shift();
  await sendText(from, reply);
  // 3b. Option B navigation buttons after every AI/general response
  await sendPostGeneralButtons(from);
}
