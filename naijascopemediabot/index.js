import express from "express";
import axios from "axios";
import Groq from "groq-sdk";
import RSSParser from "rss-parser";

// ─── Services ─────────────────────────────────────────────────────────────────
import { sendText, sendButtons, sendList, markAsRead, downloadMedia } from "./src/services/whatsappService.js";
import { sendWelcomeMessage, sendMainMenu, sendReturnMenu, sendFootballMenu, sendLanguageMenu, sendSubscriptionMenu, sendAfterNewsMenu, sendAfterFootballMenu } from "./src/whatsapp/menus.js";
import { translateArticle, saveLanguagePreference, applyUserLanguage, detectLanguageIntent, LANG_NAMES } from "./src/services/languageService.js";
import { saveArticle, getSavedArticles, deleteSavedArticle } from "./src/services/articleService.js";
import { fetchEPLStandings, fetchUCLFixtures, fetchTodaysFixtures, fetchLiveScores, fetchNPFLNews, fetchTransferNews, subscribeToTeam } from "./src/services/footballService.js";
import { verifyClaim } from "./src/services/factCheckService.js";
import { transcribeAudio, processVoiceIntent } from "./src/services/voiceService.js";
import { isHandoffRequest, transferToHuman, getOpenTicket, closeTicket } from "./src/services/supportService.js";
import { reverseGeocode, saveUserLocation, fetchLocalNews } from "./src/services/locationService.js";
import { addSubscription, removeSubscription, getSubscribers } from "./src/services/alertService.js";
import { upsertUser, getUser, query } from "./src/utils/db.js";
import { logger } from "./src/utils/logger.js";
import { pollData, getPollResults, startDailyPollJob } from "./src/jobs/dailyPoll.js";
import { startDailyBriefingJob } from "./src/jobs/dailyBriefing.js";
import { startBreakingNewsMonitor } from "./src/jobs/breakingNewsMonitor.js";

const app = express();
app.use(express.json());

// ─── ENV ───────────────────────────────────────────────────────────────────────
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ADMIN_NUMBER = process.env.ADMIN_NUMBER;

// ─── PROMPTS ───────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = "You are the NaijaScope Media Bot — the smartest Nigerian news assistant alive. You work for NaijaScope Media (www.bayelsamedia.com.ng), specializing in Niger Delta, Bayelsa State, oil and gas, Nigerian politics and current affairs. Be conversational, witty, warm and Nigerian. Keep responses SHORT and PUNCHY — max 4 lines unless the user explicitly asks for detail. Feel like a real smart person texting, not a robot. Occasionally use Nigerian expressions naturally e.g. No wahala, Sharp sharp, E don happen, Abeg. Always end with a smart follow-up question or a call to action. Use plain text only, no asterisks or markdown. Never say you cannot help. Never say you are having a small issue — if something goes wrong say something witty instead.";
const SYSTEM_PROMPT_PIDGIN = "You are the NaijaScope Media Bot — the smartest Nigerian news assistant wey ever exist. You work for NaijaScope Media (www.bayelsamedia.com.ng). You ONLY speak Nigerian Pidgin English. Never use Standard English. Be sharp, funny, warm and intelligent. Keep answers SHORT — max 4 lines. Use expressions like E don happen, Na so e be, Wetin you wan know, Abeg, Oya, No wahala. Use plain text only, no asterisks or markdown. Never say you cannot help.";

const CATEGORY_KEYWORDS = {
  politics: ["politi", "president", "governor", "senator", "minister", "APC", "PDP", "Labour Party", "election", "government", "INEC"],
  oil: ["oil", "gas", "petroleum", "NNPC", "crude", "refinery", "pipeline", "barrel", "energy"],
  crime: ["crime", "arrest", "police", "murder", "robbery", "kidnap", "court", "prison", "convict", "fraud"],
  environment: ["environ", "flood", "pollution", "climate", "forest", "farm", "deforestation", "erosion"],
  sports: ["football", "sport", "soccer", "Super Eagles", "NBA", "tennis", "athlete", "championship", "AFCON"],
  entertainment: ["music", "movie", "actor", "singer", "celebrity", "Nollywood", "award", "album"],
  election: ["election", "2027", "candidate", "campaign", "ballot", "vote", "polling"],
  nddc: ["NDDC", "Niger Delta Development", "commission", "accountability", "budget"],
  opportunities: ["scholarship", "job", "employment", "opportunity", "fellowship", "grant", "bursary", "vacancy", "internship", "award"],
};

const BAYELSA_LGAS = ["Yenagoa", "Ogbia", "Sagbama", "Ekeremor", "Kolokuma/Opokuma", "Nembe", "Brass", "Southern Ijaw"];
const rssParser = new RSSParser();

// ─── IN-MEMORY STATE ──────────────────────────────────────────────────────────
const conversationHistory = new Map();
const processedMessageIds = new Set();
const userProfiles = new Map(); // in-memory cache for quick access
const newsCache = new Map();
const rateLimit = new Map();
const tipsInProgress = new Map();
const reportsInProgress = new Map();
const awaitingTeamName = new Set();
const awaitingFactCheck = new Set();
const awaitingHandoff = new Map();
const lastSentNews = new Map();
const tips = [];
const reports = [];
const promiseTracker = new Map();
const breakingLive = { active: false, topic: "" };
const userAlerts = new Map();
const analytics = {
  totalUsers: new Set(),
  messagesPerDay: new Map(),
  commandCounts: new Map(),
  peakHours: new Array(24).fill(0),
};

const MAX_PROCESSED_IDS = 1000;
const MAX_CONVERSATION_USERS = 500;
const CACHE_TTL = 10 * 60 * 1000;
const RATE_LIMIT_MS = 3000;

// ─── UTILS ─────────────────────────────────────────────────────────────────────
function getGroq() {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set");
  return new Groq({ apiKey: GROQ_API_KEY });
}

function track(from, command) {
  analytics.totalUsers.add(from);
  const today = new Date().toISOString().slice(0, 10);
  analytics.messagesPerDay.set(today, (analytics.messagesPerDay.get(today) || 0) + 1);
  analytics.peakHours[new Date().getUTCHours()]++;
  if (command) analytics.commandCounts.set(command, (analytics.commandCounts.get(command) || 0) + 1);
}

function getCache(key) {
  const entry = newsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) { newsCache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) { newsCache.set(key, { data, timestamp: Date.now() }); }

function checkRateLimit(userId) {
  const last = rateLimit.get(userId);
  if (last && Date.now() - last < RATE_LIMIT_MS) return false;
  rateLimit.set(userId, Date.now());
  return true;
}

function trackMessageId(id) {
  if (processedMessageIds.has(id)) return false;
  processedMessageIds.add(id);
  if (processedMessageIds.size > MAX_PROCESSED_IDS)
    processedMessageIds.delete(processedMessageIds.values().next().value);
  return true;
}

function sanitizeXml(raw) {
  return raw
    .replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFE\uFFFF]/g, "");
}

function isAdmin(from) { return ADMIN_NUMBER && from === ADMIN_NUMBER; }

// ─── RSS ───────────────────────────────────────────────────────────────────────
async function fetchRSSItems(bypassCache = false) {
  if (!bypassCache) {
    const cached = getCache("rss_all");
    if (cached) return cached;
  }
  const response = await axios.get("https://www.bayelsamedia.com.ng/feed", { responseType: "text", timeout: 10000 });
  const xml = sanitizeXml(response.data);
  const feed = await rssParser.parseString(xml);
  setCache("rss_all", feed.items);
  return feed.items;
}

async function getNewsByCategory(category) {
  try {
    const cached = getCache(`cat_${category}`);
    if (cached) return cached;
    const items = await fetchRSSItems();
    const kws = CATEGORY_KEYWORDS[category] || [category];
    const filtered = items.filter(item => kws.some(kw => (item.title || "").toLowerCase().includes(kw.toLowerCase())));
    const result = (filtered.length > 0 ? filtered : items).slice(0, 5);
    setCache(`cat_${category}`, result);
    return result;
  } catch (err) {
    logger.error("getNewsByCategory error:", err.message);
    return null;
  }
}

// ─── SEND NEWS ────────────────────────────────────────────────────────────────
async function sendNewsItems(to, items, header, userRow) {
  if (!items || items.length === 0) {
    await sendText(to, "No stories found right now. Check www.bayelsamedia.com.ng 🔗");
    return;
  }
  lastSentNews.set(to, items);
  const top = items.slice(0, 5);

  const rows = top.map((item, i) => ({
    id: `story_${i}`,
    title: (item.title || "Story").slice(0, 24),
    description: `Read more →`,
  }));

  let bodyText = header || "📰 Latest from NaijaScope:";
  if (userRow?.language_pref && userRow.language_pref !== "en") {
    bodyText = await translateArticle(bodyText, userRow.language_pref);
  }

  try {
    await sendList(to, bodyText, "View Headlines", [{ title: "Top Stories", rows }]);
    const links = top.map((item, i) => `${i + 1}. ${item.title}\n🔗 ${item.link}`).join("\n\n");
    await sendText(to, `🔗 Story links:\n\n${links}`);
  } catch {
    const fallback = top.reduce((m, item, i) => m + `${i + 1}. ${item.title}\n🔗 ${item.link}\n\n`, bodyText + "\n\n") + "www.bayelsamedia.com.ng 🇳🇬";
    await sendText(to, fallback);
  }

  await sendAfterNewsMenu(to);
}

// ─── OIL PRICE ────────────────────────────────────────────────────────────────
async function fetchOilPrice() {
  try {
    const cached = getCache("oil_price");
    if (cached) return cached;
    const res = await axios.get("https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=2d", { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } });
    const meta = res.data.chart.result[0].meta;
    const price = (meta.regularMarketPrice || 0).toFixed(2);
    const prev = (meta.chartPreviousClose || meta.regularMarketPrice || 0).toFixed(2);
    const diff = (price - prev).toFixed(2);
    const arrow = diff >= 0 ? "📈" : "📉";
    const msg = `🛢️ Brent Crude: $${price}/barrel ${arrow}\nChange today: ${diff >= 0 ? "+" : ""}${diff}\n\nThe Niger Delta is watching. Want oil sector news?`;
    setCache("oil_price", msg);
    return msg;
  } catch (err) {
    return "Couldn't grab the oil price — market data dey form 😅\nType 'oil' for oil sector news.";
  }
}

async function fetchExchangeRate() {
  try {
    const cached = getCache("exchange_rate");
    if (cached) return cached;
    const res = await axios.get("https://api.exchangerate-api.com/v4/latest/USD", { timeout: 8000 });
    const ngn = res.data.rates?.NGN;
    if (!ngn) throw new Error("NGN rate not found");
    const parallel = Math.round(ngn * 1.08);
    const msg = `💵 USD/NGN Exchange Rate:\n\n🏦 Market Rate: $1 = ₦${Math.round(ngn)}\n💸 Parallel (est.): $1 = ₦${parallel}\n\nRates fluctuate — visit CBN.gov.ng for official rate.\nAnything else? 👇`;
    setCache("exchange_rate", msg);
    return msg;
  } catch {
    return "Couldn't fetch the exchange rate right now 😅\nCheck cbn.gov.ng for the official rate.";
  }
}

async function fetchWeather(city) {
  try {
    const cached = getCache(`weather_${city.toLowerCase()}`);
    if (cached) return cached;
    const res = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { timeout: 8000 });
    const cur = res.data.current_condition[0];
    const msg = `🌤️ ${city} weather:\n${cur.weatherDesc[0].value}, ${cur.temp_C}°C (feels like ${cur.FeelsLikeC}°C)\nHumidity: ${cur.humidity}%\n\nStay safe! Anything else?`;
    setCache(`weather_${city.toLowerCase()}`, msg);
    return msg;
  } catch {
    return `Couldn't get weather for ${city} right now 🌧️\nTry another city or check back soon.`;
  }
}

async function fetchFloodAlert() {
  try {
    const cached = getCache("flood_alert");
    if (cached) return cached;
    const res = await axios.get("https://wttr.in/Yenagoa?format=j1", { timeout: 8000 });
    const cur = res.data.current_condition[0];
    const rainfall = res.data.weather?.[0]?.hourly?.reduce((sum, h) => sum + parseFloat(h.precipMM || 0), 0) || 0;
    const humidity = parseInt(cur.humidity || 0);
    let risk = "LOW"; let emoji = "🟢";
    if (rainfall > 20 || humidity > 90) { risk = "HIGH"; emoji = "🔴"; }
    else if (rainfall > 8 || humidity > 80) { risk = "MODERATE"; emoji = "🟡"; }
    const lgaLines = BAYELSA_LGAS.slice(0, 5).map(lga => `• ${lga}: ${risk}`).join("\n");
    const msg = `${emoji} Bayelsa Flood Risk: ${risk}\n\n${lgaLines}\n\nRainfall: ${rainfall.toFixed(1)}mm | Humidity: ${humidity}%\n\nStay safe! Follow official BYSEMA alerts.`;
    setCache("flood_alert", msg);
    return msg;
  } catch {
    return "Couldn't fetch flood data right now 🌊\nMonitor BYSEMA and local authorities for updates.";
  }
}

// ─── AI RESPONSE ──────────────────────────────────────────────────────────────
async function getAIResponse(userId, userMessage, userRow) {
  try {
    const groq = getGroq();
    const lang = userRow?.language_pref || "en";
    const isPidgin = lang === "pidgin";

    if (!conversationHistory.has(userId)) {
      conversationHistory.set(userId, []);
      if (conversationHistory.size > MAX_CONVERSATION_USERS)
        conversationHistory.delete(conversationHistory.keys().next().value);
    }
    const history = conversationHistory.get(userId);
    let sys = isPidgin ? SYSTEM_PROMPT_PIDGIN : SYSTEM_PROMPT;
    if (userRow?.location_state) sys += ` User is from ${userRow.location_state}.`;
    const messages = [{ role: "system", content: sys }, ...history, { role: "user", content: userMessage }];
    const completion = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages, max_tokens: 300 });
    const response = completion.choices[0].message.content;
    history.push({ role: "user", content: userMessage });
    history.push({ role: "assistant", content: response });
    if (history.length > 20) history.splice(0, history.length - 20);
    return response;
  } catch (err) {
    logger.error("getAIResponse error:", err.message);
    return "Hmm, let me think on that — try again in a sec 🤔";
  }
}

// ─── TIP FLOW ─────────────────────────────────────────────────────────────────
async function runTipFlow(from, text, rawText) {
  const flow = tipsInProgress.get(from);
  if (flow.step === 1) {
    flow.data.about = rawText; flow.step = 2;
    await sendText(from, "📍 Step 2 of 3: Which location does this involve? (City/LGA/Community)");
    return true;
  }
  if (flow.step === 2) {
    flow.data.location = rawText; flow.step = 3;
    await sendText(from, "📎 Step 3 of 3: Any evidence? Send a photo or type 'none'");
    return true;
  }
  if (flow.step === 3) {
    flow.data.evidence = text === "none" ? "No evidence provided" : rawText;
    tips.push({ ...flow.data, timestamp: new Date().toISOString(), from: "anonymous" });
    tipsInProgress.delete(from);
    await sendText(from, "✅ Your tip has been submitted anonymously to NaijaScope Media.\n\nThank you for speaking up! Your identity is fully protected. 🔒");
    if (ADMIN_NUMBER) await sendText(ADMIN_NUMBER, `🔔 New Anonymous Tip:\n\nAbout: ${flow.data.about}\nLocation: ${flow.data.location}\nEvidence: ${flow.data.evidence}`);
    return true;
  }
  return false;
}

// ─── REPORT FLOW ──────────────────────────────────────────────────────────────
async function runReportFlow(from, rawText) {
  const flow = reportsInProgress.get(from);
  if (flow.step === 1) {
    flow.data.what = rawText; flow.step = 2;
    await sendText(from, "📍 Step 2 of 4: Where exactly did this happen? (Location)");
    return true;
  }
  if (flow.step === 2) {
    flow.data.where = rawText; flow.step = 3;
    await sendText(from, "🕐 Step 3 of 4: When did this happen? (Date/time)");
    return true;
  }
  if (flow.step === 3) {
    flow.data.when = rawText; flow.step = 4;
    await sendText(from, "📷 Step 4 of 4: Send a photo if you have one, or type 'none'");
    return true;
  }
  if (flow.step === 4) {
    flow.data.photo = rawText.toLowerCase() === "none" ? "No photo" : "Photo submitted";
    reports.push({ ...flow.data, timestamp: new Date().toISOString() });
    reportsInProgress.delete(from);
    await sendText(from, "✅ Story submitted to the NaijaScope newsroom!\n\nOur journalists will review your report. Thank you for being a citizen journalist! 📰🇳🇬");
    if (ADMIN_NUMBER) await sendText(ADMIN_NUMBER, `📰 New Citizen Report:\n\nWhat: ${flow.data.what}\nWhere: ${flow.data.where}\nWhen: ${flow.data.when}\nPhoto: ${flow.data.photo}`);
    return true;
  }
  return false;
}

// ─── PROMISE TRACKER ──────────────────────────────────────────────────────────
function getPromises(politicianRaw) {
  const name = politicianRaw.toLowerCase().trim();
  for (const [key, promises] of promiseTracker) {
    if (key.includes(name) || name.includes(key)) {
      const lines = promises.map((p, i) => `${i + 1}. [${p.status}] ${p.promise}`).join("\n");
      return `📋 Promise Tracker — ${key}:\n\n${lines}\n\nSource: NaijaScope Media`;
    }
  }
  return `No promise records found for "${politicianRaw}" yet.\n\nType 'help' to see all commands.`;
}

// ─── KEYWORD ALERTS ───────────────────────────────────────────────────────────
async function checkKeywordAlerts(newItems) {
  if (newItems.length === 0 || userAlerts.size === 0) return;
  for (const [userId, keywords] of userAlerts) {
    for (const item of newItems) {
      const title = (item.title || "").toLowerCase();
      for (const kw of keywords) {
        if (title.includes(kw.toLowerCase())) {
          await sendText(userId, `🔔 Keyword Alert: "${kw}"\n\n${item.title}\n🔗 ${item.link}`);
          await new Promise(r => setTimeout(r, 400));
          break;
        }
      }
    }
  }
}

// ─── ADMIN ────────────────────────────────────────────────────────────────────
async function handleAdminCommand(from, rawText) {
  const upper = rawText.trim().toUpperCase();

  if (upper.startsWith("BROADCAST ")) {
    const msg = rawText.slice(10).trim();
    const subscribers = await getSubscribers("daily_digest");
    let sent = 0;
    for (const number of subscribers) {
      await sendText(number, `📢 NaijaScope Broadcast:\n\n${msg}`);
      await new Promise(r => setTimeout(r, 600));
      sent++;
    }
    await sendText(from, `✅ Broadcast sent to ${sent} subscribers.`);
    return;
  }

  if (upper.startsWith("BREAKING ON ")) {
    const topic = rawText.slice(12).trim();
    breakingLive.active = true;
    breakingLive.topic = topic;
    await sendText(from, `🔴 Live Breaking Mode ON — Topic: ${topic}`);
    const subscribers = await getSubscribers("breaking_news");
    for (const number of subscribers) {
      await sendText(number, `🔴 LIVE: NaijaScope is now providing live updates on:\n${topic}\n\nStay tuned! 📡`);
      await new Promise(r => setTimeout(r, 600));
    }
    return;
  }

  if (upper === "BREAKING OFF") {
    breakingLive.active = false;
    await sendText(from, `✅ Live Breaking Mode OFF.`);
    breakingLive.topic = "";
    return;
  }

  if (upper.startsWith("LIVE ") && breakingLive.active) {
    const update = rawText.slice(5).trim();
    const subscribers = await getSubscribers("breaking_news");
    let sent = 0;
    for (const number of subscribers) {
      await sendText(number, `🔴 LIVE UPDATE: ${breakingLive.topic}\n\n${update}\n\nNaijaScope Media | www.bayelsamedia.com.ng`);
      await new Promise(r => setTimeout(r, 600));
      sent++;
    }
    await sendText(from, `✅ Live update sent to ${sent} subscribers.`);
    return;
  }

  if (upper === "STATS") {
    const today = new Date().toISOString().slice(0, 10);
    const todayMsgs = analytics.messagesPerDay.get(today) || 0;
    const topCmds = [...analytics.commandCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([cmd, n]) => `${cmd}: ${n}`).join(", ");
    const peakHour = analytics.peakHours.indexOf(Math.max(...analytics.peakHours));
    const dbUsers = await query("SELECT COUNT(*) FROM users");
    await sendText(from,
      `📊 Bot Stats:\n\nTotal users (DB): ${dbUsers.rows[0].count}\nActive session: ${analytics.totalUsers.size}\nMessages today: ${todayMsgs}\nTop commands: ${topCmds || "none"}\nPeak hour: ${peakHour}:00 UTC\nLive mode: ${breakingLive.active ? "ON — " + breakingLive.topic : "OFF"}`
    );
    return;
  }

  if (upper.startsWith("ADD PROMISE ")) {
    const parts = rawText.slice(12).split("|");
    if (parts.length < 2) { await sendText(from, "Usage: ADD PROMISE [politician] | [promise text]"); return; }
    const politician = parts[0].trim().toLowerCase();
    const promise = parts[1].trim();
    const status = parts[2]?.trim() || "PENDING";
    if (!promiseTracker.has(politician)) promiseTracker.set(politician, []);
    promiseTracker.get(politician).push({ promise, status, date: new Date().toISOString().slice(0, 10) });
    await sendText(from, `✅ Promise added for ${politician}: "${promise}" — ${status}`);
    return;
  }

  if (upper.startsWith("UPDATE PROMISE ")) {
    const parts = rawText.slice(15).split("|");
    if (parts.length < 3) { await sendText(from, "Usage: UPDATE PROMISE [politician] | [index] | [KEPT/BROKEN/PENDING]"); return; }
    const politician = parts[0].trim().toLowerCase();
    const idx = parseInt(parts[1].trim()) - 1;
    const newStatus = parts[2].trim().toUpperCase();
    const promises = promiseTracker.get(politician);
    if (!promises || !promises[idx]) { await sendText(from, "Promise not found."); return; }
    promises[idx].status = newStatus;
    await sendText(from, `✅ Updated: "${promises[idx].promise}" → ${newStatus}`);
    return;
  }

  if (upper.startsWith("CLOSE TICKET ")) {
    const ref = rawText.slice(13).trim();
    await closeTicket(ref);
    await sendText(from, `✅ Ticket ${ref} closed.`);
    return;
  }
}

// ─── INTERACTIVE HANDLER ──────────────────────────────────────────────────────
async function handleInteractive(from, replyId, userRow) {
  const items = await fetchRSSItems().catch(() => []);

  // Main menu navigation
  if (replyId === "top_news" || replyId === "menu_headlines") {
    track(from, "news");
    await sendNewsItems(from, items.slice(0, 5), "📰 Top stories right now:", userRow);
    return;
  }

  if (replyId === "ask_ai" || replyId === "menu_ask_ai") {
    await sendText(from, "Ask me anything about Nigeria, Niger Delta, politics, oil or current affairs! 🤖");
    return;
  }

  if (replyId === "subscribe" || replyId === "menu_subscribe") {
    track(from, "subscribe");
    await sendSubscriptionMenu(from);
    return;
  }

  if (replyId === "main_menu") {
    await sendMainMenu(from);
    return;
  }

  if (replyId === "menu_football") {
    track(from, "football");
    await sendFootballMenu(from);
    return;
  }

  if (replyId === "menu_language") {
    await sendLanguageMenu(from);
    return;
  }

  if (replyId === "menu_factcheck") {
    awaitingFactCheck.add(from);
    await sendText(from, "🔍 Send me the claim you want to fact-check:");
    return;
  }

  if (replyId === "menu_markets") {
    const oil = await fetchOilPrice();
    const fx = await fetchExchangeRate();
    await sendText(from, oil);
    await sendText(from, fx);
    return;
  }

  if (replyId === "menu_journalist") {
    track(from, "journalist");
    awaitingHandoff.set(from, true);
    await sendText(from, "🎙️ Sure! Briefly describe what you'd like to discuss with our journalist team:");
    return;
  }

  if (replyId === "menu_saved") {
    const saved = await getSavedArticles(from);
    if (saved.length === 0) {
      await sendText(from, "📚 You have no saved articles yet.\n\nAfter reading a story, tap 'Save This' to bookmark it!");
    } else {
      const lines = saved.map((a, i) => `${i + 1}. ${a.article_title}\n🔗 ${a.article_url}`).join("\n\n");
      await sendText(from, `🔖 Your saved articles:\n\n${lines}`);
    }
    return;
  }

  // Subscription buttons
  if (replyId === "sub_daily") {
    await addSubscription(from, "daily_digest");
    await upsertUser(from, { digest_enabled: true });
    await sendText(from, "☀️ Subscribed to Daily Briefing! You'll receive headlines at 7AM WAT. Sharp sharp! 📰\n\nType 'unsubscribe' anytime.");
    return;
  }

  if (replyId === "sub_breaking") {
    await addSubscription(from, "breaking_news");
    await upsertUser(from, { breaking_alerts: true });
    await sendText(from, "🔴 Subscribed to Breaking News alerts! You'll be first to know. No wahala! 📡\n\nType 'unsubscribe' anytime.");
    return;
  }

  if (replyId === "sub_opportunities") {
    await addSubscription(from, "opportunities");
    await sendText(from, "🎓 Subscribed to Opportunity alerts! I'll notify you of scholarships, grants & jobs. Sharp sharp! 🎯");
    return;
  }

  // Language selection
  if (replyId?.startsWith("lang_")) {
    const lang = replyId.replace("lang_", "");
    await saveLanguagePreference(from, lang);
    const langName = LANG_NAMES[lang] || lang;
    await sendText(from, `✅ Language set to ${langName}! I'll deliver news in ${langName} from now on. E don happen! 🇳🇬`);
    return;
  }

  // Football sub-menu
  if (replyId === "football_live") {
    await sendText(from, await fetchLiveScores());
    await sendAfterFootballMenu(from);
    return;
  }

  if (replyId === "football_fixtures") {
    await sendText(from, await fetchTodaysFixtures());
    await sendAfterFootballMenu(from);
    return;
  }

  if (replyId === "football_epl") {
    await sendText(from, await fetchEPLStandings());
    await sendAfterFootballMenu(from);
    return;
  }

  if (replyId === "football_ucl") {
    await sendText(from, await fetchUCLFixtures());
    await sendAfterFootballMenu(from);
    return;
  }

  if (replyId === "football_npfl") {
    const npfl = await fetchNPFLNews(items);
    await sendNewsItems(from, npfl, "🏟️ NPFL News:", userRow);
    return;
  }

  if (replyId === "football_transfers") {
    const transfers = await fetchTransferNews(items);
    if (transfers.length > 0) {
      await sendNewsItems(from, transfers, "🔄 Transfer News:", userRow);
    } else {
      await sendText(from, "No transfer stories in our feed right now.\n\nCheck www.bayelsamedia.com.ng for the latest! 🔗");
    }
    return;
  }

  if (replyId === "football_alerts") {
    awaitingTeamName.add(from);
    await sendText(from, "⚽ Which club do you want alerts for?\n\nJust type the team name e.g. Enyimba, Arsenal, Manchester City");
    return;
  }

  // Post-article actions
  if (replyId === "action_save") {
    const recent = lastSentNews.get(from);
    if (recent && recent[0]) {
      await saveArticle(from, recent[0]);
      await sendText(from, "🔖 Article saved! Type 'saved' to see all your bookmarks.");
    } else {
      await sendText(from, "No recent article to save. Read a story first!");
    }
    return;
  }

  if (replyId === "action_translate") {
    await sendLanguageMenu(from);
    return;
  }

  if (replyId === "action_more") {
    const recent = lastSentNews.get(from);
    if (recent && recent[0]) {
      const words = (recent[0].title || "").split(" ").slice(0, 2).join(" ");
      const more = items.filter(i => i.link !== recent[0].link && (i.title || "").toLowerCase().includes(words.toLowerCase())).slice(0, 3);
      await sendNewsItems(from, more.length > 0 ? more : items.slice(5, 10), "🔍 More stories:", userRow);
    } else {
      await sendNewsItems(from, items.slice(0, 5), "📰 Latest stories:", userRow);
    }
    return;
  }

  // Poll votes
  if (replyId?.startsWith("poll_")) {
    const optIdx = parseInt(replyId.split("_")[1]);
    if (pollData.question && optIdx >= 0 && optIdx < pollData.options.length) {
      pollData.votes.set(from, optIdx);
      await sendText(from, `✅ Vote recorded for: "${pollData.options[optIdx]}"\n\nType 'poll' to see current results!`);
    }
    return;
  }
}

// ─── WEBHOOK ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.status(200).json({ status: "ok", service: "NaijaScope Media Bot" }));

app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    logger.info("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", (req, res) => {
  res.sendStatus(200); // respond immediately — process async
  (async () => {
    try {
      const body = req.body;
      if (!body || body.object !== "whatsapp_business_account") return;
      const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!message) return;
      const from = message.from;
      const messageId = message.id;
      if (!from || !messageId) return;
      if (!trackMessageId(messageId)) return;
      await markAsRead(messageId);

      track(from, null);
      logger.info(`from=${from} type=${message.type}`);

      // Load user from DB
      const userRow = await upsertUser(from);

      // ── Check if user has open support ticket (bot paused) ────────────────
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

      // ── Interactive replies ───────────────────────────────────────────────
      if (message.type === "interactive") {
        const replyId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
        await handleInteractive(from, replyId, userRow);
        return;
      }

      // ── Location messages (Phase 12) ─────────────────────────────────────
      if (message.type === "location") {
        const { latitude, longitude } = message.location;
        await sendText(from, "📍 Got your location! Finding local news...");
        const geo = await reverseGeocode(latitude, longitude);
        await saveUserLocation(from, geo.state, geo.lga);
        const items = await fetchRSSItems();
        const local = await fetchLocalNews(items, geo.state);
        await sendNewsItems(from, local, `📰 News for ${geo.display}:`, userRow);
        return;
      }

      // ── Image messages ───────────────────────────────────────────────────
      if (message.type === "image") {
        const mediaId = message.image?.id;
        if (mediaId) {
          await sendText(from, "📸 Analyzing your image...");
          try {
            const { buffer, mimeType } = await downloadMedia(mediaId);
            const base64 = buffer.toString("base64");
            const groq = getGroq();
            const completion = await groq.chat.completions.create({
              model: "meta-llama/llama-4-scout-17b-16e-instruct",
              messages: [{ role: "user", content: [
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
                { type: "text", text: "You are a Nigerian news fact-checker. Analyze this image. Start with REAL, FAKE, or UNVERIFIED. Then 2-3 sentences on visual indicators of authenticity or manipulation. Tag: NaijaScope Fact-Check. Plain text only." },
              ]}],
              max_tokens: 250,
            });
            await sendText(from, "📸 NaijaScope Fact-Check:\n\n" + completion.choices[0].message.content);
          } catch (err) {
            logger.error("analyzeImage error:", err.message);
            await sendText(from, "📸 Couldn't analyze that image right now. Describe what you see and I'll help! 🤔");
          }
        } else {
          await sendText(from, "📷 Got your image! Describe what you need and I'll help 👇");
        }
        return;
      }

      // ── Audio messages (Phase 10) ─────────────────────────────────────────
      if (message.type === "audio") {
        const mediaId = message.audio?.id;
        if (mediaId) {
          await sendText(from, "🎤 Transcribing your voice note...");
          try {
            const transcription = await transcribeAudio(mediaId);
            await sendText(from, `🎤 Heard: "${transcription}"\n\nProcessing...`);
            if (!checkRateLimit(from)) { await sendText(from, "Easy now! Give me 3 seconds 😄"); return; }
            const { intent, text: intentText } = await processVoiceIntent(transcription);
            if (intent === "news") {
              const rssItems = await fetchRSSItems();
              await sendNewsItems(from, rssItems.slice(0, 5), "📰 Top stories:", userRow);
            } else if (intent === "football") {
              await sendFootballMenu(from);
            } else if (intent === "oil") {
              await sendText(from, await fetchOilPrice());
            } else {
              const reply = await getAIResponse(from, transcription, userRow);
              await sendText(from, reply);
            }
          } catch (err) {
            logger.error("transcribeAudio error:", err.message);
            await sendText(from, "🎤 Couldn't transcribe that voice note. Please type your message! 👇");
          }
        }
        return;
      }

      if (message.type !== "text" || !message.text?.body) return;
      const rawText = message.text.body.trim();
      const text = rawText.toLowerCase();

      // ── Active flows ──────────────────────────────────────────────────────
      if (tipsInProgress.has(from)) { await runTipFlow(from, text, rawText); return; }
      if (reportsInProgress.has(from)) { await runReportFlow(from, rawText); return; }

      // ── Awaiting team name ────────────────────────────────────────────────
      if (awaitingTeamName.has(from)) {
        awaitingTeamName.delete(from);
        await subscribeToTeam(from, rawText);
        await sendText(from, `⚡ Subscribed to ${rawText} alerts! I'll notify you of match updates. Sharp sharp! ⚽`);
        return;
      }

      // ── Awaiting fact check ───────────────────────────────────────────────
      if (awaitingFactCheck.has(from)) {
        awaitingFactCheck.delete(from);
        await sendText(from, "🔍 Checking that claim...");
        await sendText(from, await verifyClaim(rawText));
        return;
      }

      // ── Awaiting human handoff ────────────────────────────────────────────
      if (awaitingHandoff.has(from)) {
        awaitingHandoff.delete(from);
        await transferToHuman(from, rawText);
        return;
      }

      // ── Admin commands ────────────────────────────────────────────────────
      if (isAdmin(from)) {
        const upper = rawText.toUpperCase();
        if (upper.startsWith("BROADCAST ") || upper.startsWith("BREAKING ") ||
            upper === "BREAKING OFF" || upper === "STATS" ||
            upper.startsWith("ADD PROMISE ") || upper.startsWith("UPDATE PROMISE ") ||
            upper.startsWith("CLOSE TICKET ") ||
            (upper.startsWith("LIVE ") && breakingLive.active)) {
          await handleAdminCommand(from, rawText);
          return;
        }
      }

      // ── First-time user ───────────────────────────────────────────────────
      if (!userRow || !userRow.last_seen || (Date.now() - new Date(userRow.created_at).getTime() < 5000)) {
        await sendWelcomeMessage(from);
        return;
      }

      // ── Proactive return experience (Phase 13) ────────────────────────────
      if (userRow.last_seen) {
        const hoursSince = (Date.now() - new Date(userRow.last_seen).getTime()) / (1000 * 60 * 60);
        if (hoursSince > 24) {
          const items = await fetchRSSItems();
          await sendReturnMenu(from, Math.min(items.length, 5));
          return;
        }
      }

      // ── Commands ──────────────────────────────────────────────────────────
      track(from, text.split(" ")[0]);

      if (text === "menu" || text === "help") { await sendMainMenu(from); return; }

      if (text === "news" || text === "headlines") {
        const items = await fetchRSSItems();
        await sendNewsItems(from, items.slice(0, 5), "📰 Top stories right now:", userRow);
        return;
      }

      if (text === "football" || text === "soccer") { await sendFootballMenu(from); return; }

      if (text === "contact") {
        await sendText(from, "📞 NaijaScope Media:\n\n🌐 www.bayelsamedia.com.ng\n📧 admin@bayelsamedia.com.ng\n\nWe'd love to hear from you! 🇳🇬");
        return;
      }

      if (text === "subscribe") { await sendSubscriptionMenu(from); return; }

      if (text === "unsubscribe") {
        await removeSubscription(from, "daily_digest");
        await removeSubscription(from, "breaking_news");
        await sendText(from, "👋 Unsubscribed from all alerts. Type 'subscribe' anytime to rejoin. E don happen!");
        return;
      }

      if (text === "language" || text === "my language") { await sendLanguageMenu(from); return; }

      if (text === "trending") {
        const items = await fetchRSSItems();
        await sendNewsItems(from, items.slice(0, 3), "🔥 Trending on NaijaScope:", userRow);
        return;
      }

      if (text === "saved" || text === "my saved" || text === "bookmarks") {
        const saved = await getSavedArticles(from);
        if (saved.length === 0) {
          await sendText(from, "📚 No saved articles yet.\n\nAfter reading a story, tap 'Save This' to bookmark it!");
        } else {
          const lines = saved.map((a, i) => `${i + 1}. ${a.article_title}\n🔗 ${a.article_url}`).join("\n\n");
          await sendText(from, `🔖 Your saved articles:\n\n${lines}`);
        }
        return;
      }

      if (text === "oil price" || text === "oil price today") { await sendText(from, await fetchOilPrice()); return; }
      if (text === "dollar rate" || text === "exchange rate" || text === "naira rate") { await sendText(from, await fetchExchangeRate()); return; }
      if (text === "markets") { await sendText(from, await fetchOilPrice()); await sendText(from, await fetchExchangeRate()); return; }
      if (text === "flood alert" || text === "flood") { await sendText(from, await fetchFloodAlert()); return; }

      if (text.startsWith("weather ")) {
        const city = rawText.slice(8).trim();
        if (!city) { await sendText(from, "Which city? E.g: weather Yenagoa"); return; }
        await sendText(from, await fetchWeather(city));
        return;
      }

      if (text === "opportunities" || text === "jobs" || text === "scholarships") {
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
        await sendText(from, "🔍 Send me the claim you want to fact-check:");
        return;
      }

      if (isHandoffRequest(text)) {
        awaitingHandoff.set(from, true);
        await sendText(from, "🎙️ Sure! Briefly describe what you'd like to discuss with our journalist team:");
        return;
      }

      if (text === "election" || text === "2027 election") {
        await sendNewsItems(from, await getNewsByCategory("election") || [], "🗳️ 2027 Election updates:", userRow);
        return;
      }

      if (text === "nddc") {
        await sendNewsItems(from, await getNewsByCategory("nddc") || [], "📋 NDDC Tracker:", userRow);
        return;
      }

      if (text === "pidgin on") {
        await saveLanguagePreference(from, "pidgin");
        await sendText(from, "Oya! Pidgin mode don activate 🇳🇬");
        return;
      }
      if (text === "pidgin off") {
        await saveLanguagePreference(from, "en");
        await sendText(from, "Pidgin mode off. Back to English! ✅");
        return;
      }

      if (text.startsWith("promise ")) {
        const politician = rawText.slice(8).trim();
        await sendText(from, getPromises(politician));
        return;
      }

      if (text.startsWith("alert ")) {
        const kw = rawText.slice(6).trim().toLowerCase();
        if (!userAlerts.has(from)) userAlerts.set(from, new Set());
        userAlerts.get(from).add(kw);
        await sendText(from, `🔔 Alert set for "${kw}". I'll notify you when it's in the news!`);
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

      if (Object.keys(CATEGORY_KEYWORDS).includes(text)) {
        await sendNewsItems(from, await getNewsByCategory(text) || [], `📰 Latest ${text} news:`, userRow);
        return;
      }

      // Language intent detection in natural text
      const langIntent = detectLanguageIntent(text);
      if (langIntent) {
        await saveLanguagePreference(from, langIntent);
        const langName = LANG_NAMES[langIntent] || langIntent;
        await sendText(from, `✅ Language set to ${langName}! I'll deliver news in ${langName} from now on. 🇳🇬`);
        return;
      }

      // ── AI fallback ───────────────────────────────────────────────────────
      if (!checkRateLimit(from)) { await sendText(from, "Easy now! Give me 3 seconds 😄"); return; }
      const reply = await getAIResponse(from, rawText, userRow);
      await sendText(from, reply);

    } catch (err) {
      logger.error("[WEBHOOK] Unhandled error:", err.message, err.stack);
    }
  })();
});

// ─── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`NaijaScope Media Bot running on port ${PORT}`);
  startDailyBriefingJob(fetchRSSItems);
  startDailyPollJob();
  startBreakingNewsMonitor(fetchRSSItems);
});
