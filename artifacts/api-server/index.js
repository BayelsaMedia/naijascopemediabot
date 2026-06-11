import express from "express";
import axios from "axios";
import Groq, { toFile } from "groq-sdk";
import RSSParser from "rss-parser";

const app = express();
app.use(express.json());

// ─── ENV ───────────────────────────────────────────────────────────────────────
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ADMIN_NUMBER = process.env.ADMIN_NUMBER;

// ─── PROMPTS ───────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT =
  "You are the NaijaScope Media Bot — Nigeria's most intelligent news companion. You work for NaijaScope Media (www.bayelsamedia.com.ng), specialising in Niger Delta, Bayelsa State, oil and gas, Nigerian politics and current affairs. Be warm, witty and distinctly Nigerian — like a brilliant friend who happens to know everything. Keep responses TIGHT — 3 lines maximum unless the user asks for depth. Use Nigerian expressions naturally: No wahala, Sharp sharp, E don happen, Abeg, Oya, Na so. Always close with one smart follow-up question or action. Plain text only. No asterisks or markdown. Never admit you cannot help — pivot gracefully.";

const SYSTEM_PROMPT_PIDGIN =
  "You are the NaijaScope Media Bot — the sharpest news person wey Nigeria ever produce. You dey work for NaijaScope Media (www.bayelsamedia.com.ng). Respond ONLY in Nigerian Pidgin English. Be sharp, funny and intelligent. Keep answers TIGHT — 3 lines maximum. Use: E don happen, Na so e be, Wetin you wan know, Abeg, Oya, No wahala. Plain text only. Never say you cannot help.";

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

const CATEGORY_EMOJI = {
  politics: "🏛️", oil: "🛢️", crime: "🚨", environment: "🌿",
  sports: "⚽", entertainment: "🎬", election: "🗳️", nddc: "📋",
  opportunities: "🎓", general: "📰",
};

const BAYELSA_LGAS = ["Yenagoa", "Ogbia", "Sagbama", "Ekeremor", "Kolokuma/Opokuma", "Nembe", "Brass", "Southern Ijaw"];

const rssParser = new RSSParser();

// ─── STATE ─────────────────────────────────────────────────────────────────────
const conversationHistory = new Map();
const processedMessageIds = new Set();
const pidginMode = new Map();
const subscribers = new Set();
const opportunitySubscribers = new Set();
const premiumUsers = new Set();
const userProfiles = new Map();       // { name, category, onboarded, footTeam }
const bookmarks = new Map();
const lastSentNews = new Map();
const newsCache = new Map();
const rateLimit = new Map();
const knownUsers = new Set();
const pendingOnboarding = new Map();  // userId → "name" | "category" | "football"
const seenNewsLinks = new Set();
const userAlerts = new Map();
const tipsInProgress = new Map();
const reportsInProgress = new Map();
const tips = [];
const reports = [];
const promiseTracker = new Map();
const breakingLive = { active: false, topic: "" };
const pollData = { date: null, question: "", options: [], votes: new Map() };
const analytics = {
  totalUsers: new Set(),
  messagesPerDay: new Map(),
  commandCounts: new Map(),
  peakHours: new Array(24).fill(0),
  premiumCount: 0,
};
const lastSeen = new Map();           // userId → timestamp
const recentCommands = new Map();     // userId → string[] (last 5)

const MAX_PROCESSED_IDS = 1000;
const MAX_CONVERSATION_USERS = 500;
const CACHE_TTL = 10 * 60 * 1000;
const RATE_LIMIT_MS = 3000;

// ─── TIME UTILITIES ────────────────────────────────────────────────────────────
function getWATHour() { return (new Date().getUTCHours() + 1) % 24; }

function getTimeOfDay() {
  const h = getWATHour();
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}

function getTimeGreeting() {
  const t = getTimeOfDay();
  if (t === "morning") return "Good morning";
  if (t === "afternoon") return "Good afternoon";
  if (t === "evening") return "Good evening";
  return "Still up?";
}

function hoursSince(ts) {
  if (!ts) return Infinity;
  return (Date.now() - ts) / 3_600_000;
}

// ─── INTERACTION TRACKING ──────────────────────────────────────────────────────
function trackRecentCommand(userId, command) {
  const cmds = recentCommands.get(userId) || [];
  cmds.unshift(command);
  if (cmds.length > 5) cmds.length = 5;
  recentCommands.set(userId, cmds);
  lastSeen.set(userId, Date.now());
}

function getLastCommand(userId) {
  return (recentCommands.get(userId) || [])[0] || null;
}

// ─── ADAPTIVE MENU BUILDER ─────────────────────────────────────────────────────
function buildAdaptiveButtons(userId) {
  const profile = userProfiles.get(userId) || {};
  const lastCmd = getLastCommand(userId);
  const hour = getWATHour();
  const isSubscribed = subscribers.has(userId);
  const isPremium = premiumUsers.has(userId);
  const topic = profile.category;

  const buttons = [];

  // Slot 1 — News, adapted to topic or time
  if (topic && topic !== "general" && CATEGORY_EMOJI[topic]) {
    buttons.push({ id: `cat_${topic}`, title: `${CATEGORY_EMOJI[topic]} ${capitalize(topic)} News` });
  } else if (hour >= 5 && hour < 10) {
    buttons.push({ id: "btn_briefing", title: "🌅 Morning Brief" });
  } else if (hour >= 17) {
    buttons.push({ id: "btn_trending", title: "🔥 Trending Now" });
  } else {
    buttons.push({ id: "btn_news", title: "📰 Top Stories" });
  }

  // Slot 2 — Contextual, based on recent activity
  if (lastCmd === "oil" || lastCmd === "oil price") {
    buttons.push({ id: "btn_oil", title: "🛢️ Live Oil Price" });
  } else if (lastCmd === "football" || lastCmd === "sports" || profile.footTeam) {
    buttons.push({ id: "btn_football", title: "⚽ Football" });
  } else if (lastCmd === "fact check" || lastCmd === "fact") {
    buttons.push({ id: "btn_factcheck", title: "🔍 Fact-Check" });
  } else {
    buttons.push({ id: "btn_ask", title: "🤖 Ask Anything" });
  }

  // Slot 3 — Engagement / discovery
  if (!isSubscribed) {
    buttons.push({ id: "btn_subscribe", title: "📡 Daily Briefs" });
  } else if (isPremium) {
    buttons.push({ id: "btn_discover", title: "🧭 Explore Topics" });
  } else {
    buttons.push({ id: "btn_discover", title: "🧭 Explore Topics" });
  }

  return buttons;
}

function capitalize(str) { return str.charAt(0).toUpperCase() + str.slice(1); }

// ─── GROQ ──────────────────────────────────────────────────────────────────────
function getGroq() {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set");
  return new Groq({ apiKey: GROQ_API_KEY });
}

// ─── ANALYTICS ────────────────────────────────────────────────────────────────
function track(from, command) {
  analytics.totalUsers.add(from);
  const today = new Date().toISOString().slice(0, 10);
  analytics.messagesPerDay.set(today, (analytics.messagesPerDay.get(today) || 0) + 1);
  analytics.peakHours[new Date().getUTCHours()]++;
  if (command) analytics.commandCounts.set(command, (analytics.commandCounts.get(command) || 0) + 1);
}

// ─── CACHE ─────────────────────────────────────────────────────────────────────
function getCache(key) {
  const entry = newsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) { newsCache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) { newsCache.set(key, { data, timestamp: Date.now() }); }

// ─── RATE LIMIT ────────────────────────────────────────────────────────────────
function checkRateLimit(userId) {
  const last = rateLimit.get(userId);
  if (last && Date.now() - last < RATE_LIMIT_MS) return false;
  rateLimit.set(userId, Date.now());
  return true;
}

// ─── DEDUPLICATION ─────────────────────────────────────────────────────────────
function trackMessageId(id) {
  if (processedMessageIds.has(id)) return false;
  processedMessageIds.add(id);
  if (processedMessageIds.size > MAX_PROCESSED_IDS)
    processedMessageIds.delete(processedMessageIds.values().next().value);
  return true;
}

// ─── XML SANITIZATION ──────────────────────────────────────────────────────────
function sanitizeXml(raw) {
  return raw
    .replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFE\uFFFF]/g, "");
}

// ─── WHATSAPP API ──────────────────────────────────────────────────────────────
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (err) {
    console.error("sendMessage error:", err?.response?.data || err.message);
  }
}

async function sendInteractiveButtons(to, bodyText, buttons) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
          type: "button", body: { text: bodyText },
          action: { buttons: buttons.map(b => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
        },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (err) {
    console.error("sendInteractiveButtons error:", err?.response?.data || err.message);
    await sendMessage(to, bodyText + "\n\nType: news, help, or ask me anything.");
  }
}

async function sendListMessage(to, bodyText, buttonLabel, sections) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
          type: "list", body: { text: bodyText },
          action: { button: buttonLabel.slice(0, 20), sections },
        },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (err) {
    console.error("sendListMessage error:", err?.response?.data || err.message);
  }
}

async function markAsRead(messageId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", status: "read", message_id: messageId },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (err) { /* silent */ }
}

// ─── MEDIA DOWNLOAD ────────────────────────────────────────────────────────────
async function downloadWhatsAppMedia(mediaId) {
  const meta = await axios.get(
    `https://graph.facebook.com/v25.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
  const res = await axios.get(meta.data.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: "arraybuffer",
    timeout: 20000,
  });
  return { buffer: Buffer.from(res.data), mimeType: meta.data.mime_type || "audio/ogg" };
}

// ─── VOICE TRANSCRIPTION ──────────────────────────────────────────────────────
async function transcribeAudio(mediaId) {
  const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);
  const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "mp4" : "mpeg";
  const groq = getGroq();
  const file = await toFile(buffer, `audio.${ext}`, { type: mimeType });
  const result = await groq.audio.transcriptions.create({ file, model: "whisper-large-v3", language: "en" });
  return result.text;
}

// ─── IMAGE ANALYSIS ───────────────────────────────────────────────────────────
async function analyzeImage(mediaId) {
  const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);
  const base64 = buffer.toString("base64");
  const groq = getGroq();
  const completion = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
        { type: "text", text: "You are a Nigerian investigative journalist and fact-checker. Analyse this image carefully. Open with one word: REAL, FAKE, or UNVERIFIED — then a colon. Then 2 tight sentences on what you observe and why. End with: NaijaScope Fact-Check. Plain text only." },
      ],
    }],
    max_tokens: 250,
  });
  return "📸 Image Analysis\n\n" + completion.choices[0].message.content;
}

// ─── RSS FETCH ─────────────────────────────────────────────────────────────────
async function fetchRSSItems(bypassCache = false) {
  if (!bypassCache) {
    const cached = getCache("rss_all");
    if (cached) return cached;
  }
  try {
    const response = await axios.get("https://www.bayelsamedia.com.ng/feed", { responseType: "text", timeout: 10000 });
    const xml = sanitizeXml(response.data);
    const feed = await rssParser.parseString(xml);
    setCache("rss_all", feed.items);
    return feed.items;
  } catch (err) {
    console.error("fetchRSSItems error:", err.message);
    const cached = getCache("rss_all");
    if (cached) return cached;
    return [];
  }
}

async function getNewsByCategory(category) {
  try {
    const cached = getCache(`cat_${category}`);
    if (cached) return cached;
    const items = await fetchRSSItems();
    const kws = CATEGORY_KEYWORDS[category] || [category];
    const filtered = items.filter(item => kws.some(kw => (item.title || "").toLowerCase().includes(kw.toLowerCase())));
    const result = (filtered.length > 0 ? filtered : items).slice(0, 3);
    setCache(`cat_${category}`, result);
    return result;
  } catch (err) {
    console.error("getNewsByCategory error:", err.message);
    return null;
  }
}

// ─── SEND NEWS HELPER ──────────────────────────────────────────────────────────
async function sendNewsItems(to, items, header) {
  if (!items || items.length === 0) {
    await sendMessage(to, "Nothing in the feed right now. Head to www.bayelsamedia.com.ng for the full picture.");
    return;
  }
  lastSentNews.set(to, items);
  const top = items.slice(0, 5);
  const rows = top.map((item, i) => ({
    id: `story_${i}`,
    title: (item.title || "Story").slice(0, 24),
    description: (item.link || "").slice(0, 72),
  }));
  const fallback = top.reduce(
    (m, item, i) => m + `${i + 1}. ${item.title}\n${item.link}\n\n`,
    (header || "📰 NaijaScope:") + "\n\n"
  ) + "www.bayelsamedia.com.ng 🇳🇬";
  try {
    await sendListMessage(to, header || "📰 NaijaScope:", "View Headlines", [{ title: "Top Stories", rows }]);
    const links = top.map((item, i) => `${i + 1}. ${item.link}`).join("\n");
    await sendMessage(to, `🔗 Story links:\n${links}`);
  } catch {
    await sendMessage(to, fallback);
  }
  await sendAfterNewsMenu(to);
}

async function sendAfterNewsMenu(to) {
  try {
    await sendInteractiveButtons(
      to,
      "What next?",
      [
        { id: "action_why", title: "💡 Why It Matters" },
        { id: "action_save", title: "🔖 Save Story" },
        { id: "action_more", title: "🧭 More Like This" },
      ]
    );
  } catch { /* non-critical, skip silently */ }
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
    const diff = (parseFloat(price) - parseFloat(prev)).toFixed(2);
    const arrow = parseFloat(diff) >= 0 ? "📈" : "📉";
    const sign = parseFloat(diff) >= 0 ? "+" : "";
    const msg = `🛢️ Brent Crude: $${price}/barrel ${arrow}\nToday: ${sign}${diff} | Niger Delta watching.\n\nWant oil sector news? Type 'oil'.`;
    setCache("oil_price", msg);
    return msg;
  } catch (err) {
    console.error("fetchOilPrice error:", err.message);
    return "Market data is taking a break right now 😅\nType 'oil' for oil sector headlines instead.";
  }
}

// ─── EXCHANGE RATE ─────────────────────────────────────────────────────────────
async function fetchExchangeRate() {
  try {
    const cached = getCache("exchange_rate");
    if (cached) return cached;
    const res = await axios.get("https://api.exchangerate-api.com/v4/latest/USD", { timeout: 8000 });
    const ngn = res.data.rates?.NGN;
    if (!ngn) throw new Error("NGN rate not found");
    const parallel = Math.round(ngn * 1.08);
    const msg = `💵 Dollar to Naira\n\n🏦 Official: $1 = ₦${Math.round(ngn)}\n💸 Parallel (est.): $1 = ₦${parallel}\n\nSource: ExchangeRate-API. cbn.gov.ng for CBN official rate.`;
    setCache("exchange_rate", msg);
    return msg;
  } catch (err) {
    console.error("fetchExchangeRate error:", err.message);
    return "Exchange rate data is off right now. Try cbn.gov.ng for the official CBN rate.";
  }
}

// ─── WEATHER ──────────────────────────────────────────────────────────────────
async function fetchWeather(city) {
  try {
    const cacheKey = `weather_${city.toLowerCase()}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;
    const res = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { timeout: 8000 });
    const cur = res.data.current_condition[0];
    const msg = `🌤️ ${city} — ${cur.weatherDesc[0].value}\n${cur.temp_C}°C (feels ${cur.FeelsLikeC}°C) · Humidity ${cur.humidity}%\n\nStay safe out there.`;
    setCache(cacheKey, msg);
    return msg;
  } catch (err) {
    console.error("fetchWeather error:", err.message);
    return `Couldn't pull weather for ${city} right now. Try again shortly.`;
  }
}

// ─── FLOOD ALERTS ─────────────────────────────────────────────────────────────
async function fetchFloodAlert() {
  try {
    const cached = getCache("flood_alert");
    if (cached) return cached;
    const res = await axios.get("https://wttr.in/Yenagoa?format=j1", { timeout: 8000 });
    const cur = res.data.current_condition[0];
    const rainfall = res.data.weather?.[0]?.hourly?.reduce((sum, h) => sum + parseFloat(h.precipMM || 0), 0) || 0;
    const humidity = parseInt(cur.humidity || 0);
    let risk = "LOW"; let badge = "🟢";
    if (rainfall > 20 || humidity > 90) { risk = "HIGH"; badge = "🔴"; }
    else if (rainfall > 8 || humidity > 80) { risk = "MODERATE"; badge = "🟡"; }
    const lgaLines = BAYELSA_LGAS.slice(0, 5).map(lga => `• ${lga}: ${risk}`).join("\n");
    const msg = `${badge} Bayelsa Flood Risk: ${risk}\n\n${lgaLines}\n\nRainfall: ${rainfall.toFixed(1)}mm · Humidity: ${humidity}%\n\nFollow BYSEMA for official alerts.`;
    setCache("flood_alert", msg);
    if (risk === "HIGH") {
      for (const number of subscribers) {
        await sendMessage(number, `🚨 FLOOD ALERT — Bayelsa State\n\n${msg}`);
        await new Promise(r => setTimeout(r, 600));
      }
    }
    return msg;
  } catch (err) {
    console.error("fetchFloodAlert error:", err.message);
    return "Flood data unavailable right now. Monitor BYSEMA and your local authorities.";
  }
}

// ─── OPPORTUNITIES ────────────────────────────────────────────────────────────
async function fetchOpportunities() {
  try {
    const cached = getCache("opportunities");
    if (cached) return cached;
    const items = await fetchRSSItems();
    const kws = CATEGORY_KEYWORDS.opportunities;
    const opps = items.filter(item => kws.some(kw => (item.title || "").toLowerCase().includes(kw))).slice(0, 3);
    const result = opps.length > 0 ? opps : null;
    if (result) setCache("opportunities", result);
    return result;
  } catch (err) {
    console.error("fetchOpportunities error:", err.message);
    return null;
  }
}

// ─── AI RESPONSE ──────────────────────────────────────────────────────────────
async function getAIResponse(userId, userMessage) {
  try {
    const groq = getGroq();
    const isPidgin = pidginMode.get(userId) || false;
    const profile = userProfiles.get(userId);
    if (!conversationHistory.has(userId)) {
      conversationHistory.set(userId, []);
      if (conversationHistory.size > MAX_CONVERSATION_USERS)
        conversationHistory.delete(conversationHistory.keys().next().value);
    }
    const history = conversationHistory.get(userId);
    let sys = isPidgin ? SYSTEM_PROMPT_PIDGIN : SYSTEM_PROMPT;
    if (profile?.name) sys += ` User's name is ${profile.name}.`;
    if (profile?.category) sys += ` Prefers ${profile.category} news.`;
    if (premiumUsers.has(userId)) sys += " Premium user — go deeper when asked.";
    const messages = [{ role: "system", content: sys }, ...history, { role: "user", content: userMessage }];
    const completion = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages, max_tokens: 300 });
    const response = completion.choices[0].message.content;
    history.push({ role: "user", content: userMessage });
    history.push({ role: "assistant", content: response });
    if (history.length > 20) history.splice(0, history.length - 20);
    return response;
  } catch (err) {
    console.error("getAIResponse error:", err.message);
    return "Sharp question — give me one second to think on that. Try again now?";
  }
}

async function getStoryExplainer(title) {
  try {
    const groq = getGroq();
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "You are a senior NaijaScope journalist writing a 'Why This Matters' explainer for Nigerian readers, especially those in the Niger Delta. 3 sentences max. Start with the direct impact. Plain text only." },
        { role: "user", content: `Story: ${title}\n\nWhy does this matter for Nigerians?` },
      ],
      max_tokens: 200,
    });
    return "💡 Why This Matters\n\n" + completion.choices[0].message.content;
  } catch (err) {
    console.error("getStoryExplainer error:", err.message);
    return "Context unavailable right now — head to www.bayelsamedia.com.ng for the full story.";
  }
}

async function factCheck(claim) {
  try {
    const groq = getGroq();
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "You are a NaijaScope fact-checker. Open with exactly one word: TRUE, FALSE, or UNVERIFIED — then a colon. Then 2 tight sentences: what the evidence shows and what readers should know. End with: NaijaScope Fact-Check. Plain text only." },
        { role: "user", content: `Fact check: ${claim}` },
      ],
      max_tokens: 200,
    });
    return "🔍 Fact-Check\n\n" + completion.choices[0].message.content;
  } catch (err) {
    console.error("factCheck error:", err.message);
    return "Fact-check is processing slowly. Try again in a moment.";
  }
}

// ─── DAILY POLL ───────────────────────────────────────────────────────────────
async function generateDailyPoll() {
  try {
    const groq = getGroq();
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "Generate one sharp, topical opinion poll about Nigerian politics, oil sector, or Niger Delta. Return ONLY valid JSON: {\"question\": string, \"options\": [3 strings max 20 chars each]}. No markdown." }],
      max_tokens: 150,
    });
    const json = JSON.parse(completion.choices[0].message.content.trim().replace(/```json?|```/g, "").trim());
    return { question: json.question, options: json.options.slice(0, 3) };
  } catch {
    return { question: "How do you rate govt's handling of Niger Delta oil revenue?", options: ["Excellent", "Average", "Poor"] };
  }
}

async function sendPollToSubscribers() {
  if (subscribers.size === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  if (pollData.date === today) return;
  const poll = await generateDailyPoll();
  pollData.date = today; pollData.question = poll.question; pollData.options = poll.options; pollData.votes = new Map();
  for (const number of subscribers) {
    try {
      const pollButtons = poll.options
        .slice(0, 3)
        .filter(opt => opt != null)
        .map((opt, i) => ({ id: `poll_${i}`, title: String(opt) }));
      await sendInteractiveButtons(number, `📊 NaijaScope Daily Poll\n\n${poll.question}`, pollButtons);
      await new Promise(r => setTimeout(r, 800));
    } catch (err) { console.error("[POLL] send error:", err.message); }
  }
}

function getPollResults() {
  if (!pollData.question) return "No active poll today. Come back tomorrow for a fresh question. 📊";
  const total = pollData.votes.size;
  if (total === 0) return `📊 Today's Poll\n\n${pollData.question}\n\nNo votes yet — be the first to weigh in.`;
  const counts = [0, 0, 0];
  for (const v of pollData.votes.values()) counts[v]++;
  const bar = (n) => "█".repeat(Math.round((n / total) * 10)).padEnd(10, "░");
  const lines = pollData.options.map((opt, i) =>
    `${opt}\n${bar(counts[i])} ${total > 0 ? Math.round((counts[i] / total) * 100) : 0}% (${counts[i]})`
  ).join("\n\n");
  return `📊 Poll Results\n\n${pollData.question}\n\n${lines}\n\n${total} votes total.`;
}

// ─── PROMISE TRACKER ──────────────────────────────────────────────────────────
function getPromises(politicianRaw) {
  const name = politicianRaw.toLowerCase().trim();
  for (const [key, promises] of promiseTracker) {
    if (key.includes(name) || name.includes(key)) {
      const lines = promises.map((p, i) => {
        const icon = p.status === "KEPT" ? "✅" : p.status === "BROKEN" ? "❌" : "⏳";
        return `${i + 1}. ${icon} ${p.promise}`;
      }).join("\n");
      return `📋 Promise Tracker — ${capitalize(key)}\n\n${lines}\n\nSource: NaijaScope Media`;
    }
  }
  return `No promise records yet for "${politicianRaw}".\n\nType 'track [politician name]' to search. We're building this database daily.`;
}

// ─── KEYWORD ALERTS ───────────────────────────────────────────────────────────
async function checkKeywordAlerts(newItems) {
  if (newItems.length === 0 || userAlerts.size === 0) return;
  for (const [userId, keywords] of userAlerts) {
    for (const item of newItems) {
      const title = (item.title || "").toLowerCase();
      for (const kw of keywords) {
        if (title.includes(kw.toLowerCase())) {
          await sendMessage(userId, `🔔 Alert: "${kw}"\n\n${item.title}\n${item.link}\n\nType 'why' for context on this story.`);
          await new Promise(r => setTimeout(r, 400));
          break;
        }
      }
    }
  }
}

// ─── ADMIN ────────────────────────────────────────────────────────────────────
function isAdmin(from) { return ADMIN_NUMBER && from === ADMIN_NUMBER; }

async function handleAdminCommand(from, rawText) {
  const upper = rawText.trim().toUpperCase();

  if (upper.startsWith("BROADCAST ")) {
    const msg = rawText.slice(10).trim();
    let sent = 0;
    for (const number of subscribers) {
      await sendMessage(number, `📢 NaijaScope\n\n${msg}`);
      await new Promise(r => setTimeout(r, 600));
      sent++;
    }
    await sendMessage(from, `✅ Broadcast delivered to ${sent} subscribers.`);
    return;
  }

  if (upper.startsWith("BREAKING ON ")) {
    const topic = rawText.slice(12).trim();
    breakingLive.active = true; breakingLive.topic = topic;
    await sendMessage(from, `🔴 LIVE MODE — ${topic}\n\nSend updates as: LIVE [update]`);
    for (const number of subscribers) {
      await sendMessage(number, `🔴 LIVE COVERAGE\n\nNaijaScope is following: ${topic}\n\nUpdates incoming. Stay close. 📡`);
      await new Promise(r => setTimeout(r, 600));
    }
    return;
  }

  if (upper === "BREAKING OFF") {
    breakingLive.active = false; breakingLive.topic = "";
    await sendMessage(from, `✅ Live mode off.`);
    return;
  }

  if (upper.startsWith("LIVE ") && breakingLive.active) {
    const update = rawText.slice(5).trim();
    let sent = 0;
    for (const number of subscribers) {
      await sendMessage(number, `🔴 LIVE: ${breakingLive.topic}\n\n${update}\n\nNaijaScope · www.bayelsamedia.com.ng`);
      await new Promise(r => setTimeout(r, 600));
      sent++;
    }
    await sendMessage(from, `✅ Update sent to ${sent} subscribers.`);
    return;
  }

  if (upper === "STATS") {
    const today = new Date().toISOString().slice(0, 10);
    const topCmds = [...analytics.commandCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${c}: ${n}`).join(", ");
    const peak = analytics.peakHours.indexOf(Math.max(...analytics.peakHours));
    await sendMessage(from, `📊 NaijaScope Stats\n\nUsers: ${analytics.totalUsers.size}\nSubscribers: ${subscribers.size}\nPremium: ${premiumUsers.size}\nMsgs today: ${analytics.messagesPerDay.get(today) || 0}\nTop commands: ${topCmds || "—"}\nPeak: ${peak}:00 UTC\nLive: ${breakingLive.active ? "ON — " + breakingLive.topic : "OFF"}`);
    return;
  }

  if (upper.startsWith("ADD PROMISE ")) {
    const parts = rawText.slice(12).split("|");
    if (parts.length < 2) { await sendMessage(from, "Usage: ADD PROMISE [politician] | [promise]"); return; }
    const politician = parts[0].trim().toLowerCase();
    const promise = parts[1].trim();
    const status = parts[2]?.trim() || "PENDING";
    if (!promiseTracker.has(politician)) promiseTracker.set(politician, []);
    promiseTracker.get(politician).push({ promise, status, date: new Date().toISOString().slice(0, 10) });
    await sendMessage(from, `✅ Promise logged for ${politician}: "${promise}" — ${status}`);
    return;
  }

  if (upper.startsWith("UPDATE PROMISE ")) {
    const parts = rawText.slice(15).split("|");
    if (parts.length < 3) { await sendMessage(from, "Usage: UPDATE PROMISE [politician] | [index] | [KEPT/BROKEN/PENDING]"); return; }
    const politician = parts[0].trim().toLowerCase();
    const idx = parseInt(parts[1].trim()) - 1;
    const newStatus = parts[2].trim().toUpperCase();
    const promises = promiseTracker.get(politician);
    if (!promises?.[idx]) { await sendMessage(from, "Promise not found. Check the name and index."); return; }
    promises[idx].status = newStatus;
    await sendMessage(from, `✅ Updated: "${promises[idx].promise}" → ${newStatus}`);
    return;
  }

  await sendMessage(from, "Admin commands: BROADCAST [msg] · BREAKING ON [topic] · BREAKING OFF · LIVE [update] · STATS · ADD PROMISE [name] | [promise] · UPDATE PROMISE [name] | [#] | [status]");
}

// ─── ADAPTIVE HOME MENU ───────────────────────────────────────────────────────
async function sendAdaptiveMenu(to) {
  const profile = userProfiles.get(to);
  const name = profile?.name ? `, ${profile.name}` : "";
  const hours = hoursSince(lastSeen.get(to));
  const greeting = getTimeGreeting();

  let intro;
  if (hours > 24) {
    intro = `${greeting}${name}. You've been away — a lot has happened. What are you picking up?`;
  } else if (hours > 4) {
    intro = `${greeting}${name}. Back for more? Nigeria's been busy.`;
  } else {
    intro = `${greeting}${name}. What do you need?`;
  }

  const buttons = buildAdaptiveButtons(to);
  await sendInteractiveButtons(to, intro, buttons);
}

// ─── RETURNING USER EXPERIENCE ────────────────────────────────────────────────
async function sendReturnExperience(from) {
  const hours = hoursSince(lastSeen.get(from));
  const profile = userProfiles.get(from) || {};
  const name = profile.name || null;

  if (hours > 48) {
    const items = await fetchRSSItems();
    const top = items.slice(0, 3);
    if (top.length > 0) {
      const headlines = top.map((item, i) => `${i + 1}. ${item.title}`).join("\n");
      await sendMessage(from, `${name ? name + ", you" : "You"}'ve been away. Here's what NaijaScope covered:\n\n${headlines}\n\nwww.bayelsamedia.com.ng`);
      lastSentNews.set(from, top);
      await sendAfterNewsMenu(from);
      return true;
    }
  }
  return false;
}

// ─── ONBOARDING ───────────────────────────────────────────────────────────────
async function runOnboarding(from, text, rawText) {
  const step = pendingOnboarding.get(from);

  if (step === "name") {
    const name = rawText.trim().split(/\s+/)[0];
    userProfiles.set(from, { name, onboarded: false });
    pendingOnboarding.set(from, "category");
    await sendListMessage(
      from,
      `Good to meet you, ${name}. What kind of news matters most to you?`,
      "Pick a topic",
      [{
        title: "News Categories",
        rows: [
          { id: "onboard_politics", title: "🏛️ Politics", description: "Government, elections, parties" },
          { id: "onboard_oil", title: "🛢️ Oil & Gas", description: "NNPC, crude prices, energy" },
          { id: "onboard_sports", title: "⚽ Sports", description: "Super Eagles, AFCON, football" },
          { id: "onboard_environment", title: "🌿 Environment", description: "Floods, climate, Niger Delta" },
          { id: "onboard_opportunities", title: "🎓 Opportunities", description: "Jobs, scholarships, grants" },
          { id: "onboard_general", title: "📰 Everything", description: "All categories, broad coverage" },
        ],
      }]
    );
    return true;
  }

  if (step === "category") {
    const cats = Object.keys(CATEGORY_KEYWORDS);
    const category = cats.find(c => text.toLowerCase().includes(c)) || "general";
    const profile = userProfiles.get(from) || {};
    userProfiles.set(from, { ...profile, category, onboarded: false });
    pendingOnboarding.set(from, "football");
    await sendMessage(from, `Noted — ${CATEGORY_EMOJI[category] || "📰"} ${capitalize(category)} coverage, locked in.\n\nOne last thing — do you follow Nigerian football? Tell me your team, or type 'skip'.`);
    return true;
  }

  if (step === "football") {
    const profile = userProfiles.get(from) || {};
    const footTeam = text === "skip" || text === "no" ? null : rawText.trim();
    userProfiles.set(from, { ...profile, footTeam, onboarded: true });
    pendingOnboarding.delete(from);
    knownUsers.add(from);

    const teamLine = footTeam ? `Your team: ${footTeam}. I've got you. ⚽` : "";
    const catEmoji = CATEGORY_EMOJI[profile.category] || "📰";
    await sendMessage(from,
      `You're set up, ${profile.name || "Chief"}. ${teamLine}\n\n${catEmoji} ${capitalize(profile.category || "General")} news · Breaking alerts · AI at your fingertips.\n\nType 'news' to start, or ask me anything.`
    );

    const items = await fetchRSSItems();
    if (items.length > 0) {
      await sendNewsItems(from, items.slice(0, 3), `📰 Here's what's happening right now:`);
    }
    return true;
  }

  return false;
}

// ─── TIP FLOW ─────────────────────────────────────────────────────────────────
async function runTipFlow(from, text, rawText) {
  const flow = tipsInProgress.get(from);

  if (flow.step === 1) {
    flow.data.about = rawText; flow.step = 2;
    await sendMessage(from, "📍 Step 2 of 3 — Where did this happen? City, community, or region.");
    return true;
  }
  if (flow.step === 2) {
    flow.data.location = rawText; flow.step = 3;
    await sendMessage(from, "📎 Step 3 of 3 — Any evidence? Send a photo now, or type 'none' to submit without.");
    return true;
  }
  if (flow.step === 3) {
    flow.data.evidence = text === "none" ? "None provided" : rawText;
    tips.push({ ...flow.data, timestamp: new Date().toISOString(), from: "anonymous" });
    tipsInProgress.delete(from);
    await sendMessage(from, "✅ Tip received by NaijaScope.\n\nYour identity is completely protected. Our team will investigate. Thank you for keeping us honest. 🔒");
    if (ADMIN_NUMBER) {
      await sendMessage(ADMIN_NUMBER, `🔔 New Tip\n\nAbout: ${flow.data.about}\nLocation: ${flow.data.location}\nEvidence: ${flow.data.evidence}`);
    }
    return true;
  }
  return false;
}

// ─── REPORT FLOW ──────────────────────────────────────────────────────────────
async function runReportFlow(from, rawText) {
  const flow = reportsInProgress.get(from);

  if (flow.step === 1) {
    flow.data.what = rawText; flow.step = 2;
    await sendMessage(from, "📍 Step 2 of 4 — Where exactly did this happen?");
    return true;
  }
  if (flow.step === 2) {
    flow.data.where = rawText; flow.step = 3;
    await sendMessage(from, "🕐 Step 3 of 4 — When did this happen?");
    return true;
  }
  if (flow.step === 3) {
    flow.data.when = rawText; flow.step = 4;
    await sendMessage(from, "📷 Step 4 of 4 — Send a photo as evidence, or type 'none'.");
    return true;
  }
  if (flow.step === 4) {
    flow.data.photo = rawText.toLowerCase() === "none" ? "No photo" : "Photo submitted";
    reports.push({ ...flow.data, timestamp: new Date().toISOString() });
    reportsInProgress.delete(from);
    await sendMessage(from, "✅ Story submitted to the NaijaScope newsroom.\n\nOur journalists will review and reach out if we pursue it. You just did something important. 📰");
    if (ADMIN_NUMBER) {
      await sendMessage(ADMIN_NUMBER, `📰 Citizen Report\n\nWhat: ${flow.data.what}\nWhere: ${flow.data.where}\nWhen: ${flow.data.when}\nPhoto: ${flow.data.photo}`);
    }
    return true;
  }
  return false;
}

// ─── DISCOVER ─────────────────────────────────────────────────────────────────
async function sendDiscoverMenu(to) {
  const profile = userProfiles.get(to) || {};
  const currentTopic = profile.category || "general";

  const allTopics = Object.keys(CATEGORY_KEYWORDS).filter(t => t !== currentTopic);
  const rows = allTopics.slice(0, 6).map(t => ({
    id: `cat_${t}`,
    title: `${CATEGORY_EMOJI[t] || "📰"} ${capitalize(t)}`,
    description: `NaijaScope ${t} coverage`,
  }));

  await sendListMessage(
    to,
    `Explore NaijaScope's full coverage. What catches your eye?`,
    "Browse Topics",
    [{ title: "All Topics", rows }]
  );
}

// ─── FOOTBALL EXPERIENCE ──────────────────────────────────────────────────────
async function sendFootballExperience(to) {
  const profile = userProfiles.get(to) || {};
  const team = profile.footTeam;
  const items = await getNewsByCategory("sports");
  const header = team ? `⚽ ${team} & Nigerian Football` : "⚽ Nigerian Football";
  if (items && items.length > 0) {
    await sendNewsItems(to, items, header);
  } else {
    await sendMessage(to, `${header}\n\nNo football stories in the feed right now. Check back or visit www.bayelsamedia.com.ng.`);
  }
}

// ─── BACKGROUND JOBS ──────────────────────────────────────────────────────────
function startDailyDigest() {
  setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() === 6 && now.getUTCMinutes() < 5 && subscribers.size > 0) {
      try {
        const items = await fetchRSSItems(true);
        for (const number of subscribers) {
          const profile = userProfiles.get(number) || {};
          const name = profile.name ? `, ${profile.name}` : "";
          await sendMessage(number, `🌅 Good morning${name}. Your NaijaScope daily digest is ready.`);
          await sendNewsItems(number, items.slice(0, 5), "📰 Top 5 this morning:");
          await new Promise(r => setTimeout(r, 1200));
        }
      } catch (err) { console.error("[DIGEST] error:", err.message); }
    }
  }, 5 * 60 * 1000);
}

function startDailyPoll() {
  setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() === 8 && now.getUTCMinutes() < 5) {
      await sendPollToSubscribers();
    }
  }, 5 * 60 * 1000);
}

function startBreakingNewsMonitor() {
  fetchRSSItems().then(items => items.slice(0, 15).forEach(i => seenNewsLinks.add(i.link))).catch(() => {});
  setInterval(async () => {
    if (subscribers.size === 0 && userAlerts.size === 0) return;
    try {
      const items = await fetchRSSItems(true);
      const fresh = items.filter(item => !seenNewsLinks.has(item.link));
      if (fresh.length === 0) return;
      fresh.forEach(item => seenNewsLinks.add(item.link));
      if (seenNewsLinks.size > 300) {
        const arr = [...seenNewsLinks];
        arr.slice(0, arr.length - 150).forEach(l => seenNewsLinks.delete(l));
      }
      await checkKeywordAlerts(fresh);
      if (subscribers.size > 0) {
        for (const item of fresh.slice(0, 2)) {
          const alert = `🔴 BREAKING\n\n${item.title}\n${item.link}\n\nType 'why' for context · NaijaScope`;
          for (const number of subscribers) {
            await sendMessage(number, alert);
            await new Promise(r => setTimeout(r, 600));
          }
        }
      }
    } catch (err) { console.error("[BREAKING NEWS] error:", err.message); }
  }, 5 * 60 * 1000);
}

// ─── WEBHOOK ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.status(200).send("NaijaScope Media Bot is running"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", (req, res) => {
  res.sendStatus(200);
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

      // ── INTERACTIVE REPLIES ─────────────────────────────────────────────────
      if (message.type === "interactive") {
        const replyId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
        trackRecentCommand(from, replyId || "interactive");

        if (replyId === "btn_news") {
          const items = await fetchRSSItems();
          await sendNewsItems(from, items.slice(0, 5), "📰 Top Stories");
        } else if (replyId === "btn_briefing") {
          const items = await fetchRSSItems();
          const profile = userProfiles.get(from) || {};
          await sendNewsItems(from, items.slice(0, 5), `🌅 Your morning briefing${profile.name ? ", " + profile.name : ""}`);
        } else if (replyId === "btn_trending") {
          const items = await fetchRSSItems();
          await sendNewsItems(from, items.slice(0, 3), "🔥 Trending now on NaijaScope:");
        } else if (replyId === "btn_ask") {
          await sendMessage(from, "Ask me anything — Nigerian politics, oil, Niger Delta, current affairs, or whatever's on your mind. 🤖");
        } else if (replyId === "btn_subscribe") {
          subscribers.add(from);
          await sendMessage(from, "You're in. Every morning at 7AM WAT, your digest lands here. Breaking stories come through the moment they break.\n\nType 'alert me about [topic]' to add keyword alerts too.");
        } else if (replyId === "btn_discover" || replyId === "btn_explore") {
          await sendDiscoverMenu(from);
        } else if (replyId === "btn_football") {
          await sendFootballExperience(from);
        } else if (replyId === "btn_oil") {
          await sendMessage(from, await fetchOilPrice());
        } else if (replyId === "btn_factcheck") {
          await sendMessage(from, "Send me a claim to verify — a headline, a rumour, or a statement. I'll tell you what checks out.\n\nOr type: fact check [your claim]");
        } else if (replyId?.startsWith("cat_")) {
          const category = replyId.slice(4);
          const emoji = CATEGORY_EMOJI[category] || "📰";
          const items = await getNewsByCategory(category);
          await sendNewsItems(from, items || [], `${emoji} ${capitalize(category)} News`);
        } else if (replyId?.startsWith("onboard_")) {
          const category = replyId.slice(8);
          const profile = userProfiles.get(from) || {};
          userProfiles.set(from, { ...profile, category });
          pendingOnboarding.set(from, "football");
          const emoji = CATEGORY_EMOJI[category] || "📰";
          await sendMessage(from, `${emoji} ${capitalize(category)} — locked in.\n\nOne last thing — do you follow Nigerian football? Tell me your team, or type 'skip'.`);
        } else if (replyId === "action_why") {
          const recent = lastSentNews.get(from);
          if (recent?.[0]) {
            await sendMessage(from, "On it — pulling context now...");
            await sendMessage(from, await getStoryExplainer(recent[0].title));
          } else {
            await sendMessage(from, "Read a story first, then tap 'Why It Matters' to get the context. Type 'news' to start.");
          }
        } else if (replyId === "action_save") {
          const recent = lastSentNews.get(from);
          if (!recent?.length) {
            await sendMessage(from, "No recent story to save. Type 'news' first.");
            return;
          }
          const story = recent[0];
          if (!bookmarks.has(from)) bookmarks.set(from, []);
          const saved = bookmarks.get(from);
          if (saved.some(s => s.link === story.link)) {
            await sendMessage(from, "Already in your saved stories. Type 'saved' to view them.");
          } else {
            saved.push({ title: story.title, link: story.link });
            await sendMessage(from, `📌 Saved: ${story.title}\n\nType 'saved' anytime to find it.`);
          }
        } else if (replyId === "action_more") {
          const profile = userProfiles.get(from) || {};
          const recent = lastSentNews.get(from);
          const category = profile.category || "general";
          const emoji = CATEGORY_EMOJI[category] || "📰";
          const items = await getNewsByCategory(category);
          await sendNewsItems(from, items || [], `${emoji} More ${capitalize(category)} coverage:`);
        } else if (replyId?.startsWith("poll_")) {
          const optIdx = parseInt(replyId.split("_")[1]);
          if (pollData.question && optIdx >= 0 && optIdx < pollData.options.length) {
            pollData.votes.set(from, optIdx);
            await sendMessage(from, `✅ Vote counted: "${pollData.options[optIdx]}"\n\nType 'poll' to see live results.`);
          }
        } else if (replyId?.startsWith("story_")) {
          await sendMessage(from, "Tap the link above to read the full story on NaijaScope. Type 'why' for AI context on it.");
        }
        return;
      }

      // ── IMAGE ───────────────────────────────────────────────────────────────
      if (message.type === "image") {
        const mediaId = message.image?.id;
        if (mediaId) {
          await sendMessage(from, "📸 Analysing your image...");
          try {
            await sendMessage(from, await analyzeImage(mediaId));
          } catch (err) {
            console.error("analyzeImage error:", err.message);
            await sendMessage(from, "Couldn't read that image. Try describing the claim in text and I'll fact-check it.");
          }
        } else {
          await sendMessage(from, "Got your image. What do you need — a fact-check, or something else?");
        }
        return;
      }

      // ── AUDIO ───────────────────────────────────────────────────────────────
      if (message.type === "audio") {
        const mediaId = message.audio?.id;
        if (mediaId) {
          await sendMessage(from, "🎤 Transcribing...");
          try {
            const transcription = await transcribeAudio(mediaId);
            await sendMessage(from, `🎤 Heard: "${transcription}"\n\nProcessing...`);
            if (!checkRateLimit(from)) { await sendMessage(from, "Easy — give me 3 seconds. 😄"); return; }
            await sendMessage(from, await getAIResponse(from, transcription));
          } catch (err) {
            console.error("transcribeAudio error:", err.message);
            await sendMessage(from, "Couldn't catch that voice note. Try typing it instead.");
          }
        } else {
          await sendMessage(from, "Voice note received. Type your question and I'll answer it. 👇");
        }
        return;
      }

      if (message.type !== "text" || !message.text?.body) return;

      const rawText = message.text.body.trim();
      const text = rawText.toLowerCase();

      // ── MULTI-STEP FLOWS ────────────────────────────────────────────────────
      if (tipsInProgress.has(from)) { await runTipFlow(from, text, rawText); return; }
      if (reportsInProgress.has(from)) { await runReportFlow(from, rawText); return; }
      if (pendingOnboarding.has(from)) {
        const handled = await runOnboarding(from, text, rawText);
        if (handled) return;
      }

      // ── ADMIN ───────────────────────────────────────────────────────────────
      if (isAdmin(from)) {
        const upper = rawText.toUpperCase();
        if (
          upper.startsWith("BROADCAST ") || upper.startsWith("BREAKING ") ||
          upper === "BREAKING OFF" || upper === "STATS" ||
          upper.startsWith("ADD PROMISE ") || upper.startsWith("UPDATE PROMISE ") ||
          (upper.startsWith("LIVE ") && breakingLive.active)
        ) {
          await handleAdminCommand(from, rawText);
          return;
        }
      }

      // ── NEW USER WELCOME ────────────────────────────────────────────────────
      if (!knownUsers.has(from)) {
        knownUsers.add(from);
        pendingOnboarding.set(from, "name");
        await sendMessage(from,
          "Welcome to NaijaScope — Nigeria's most intelligent news experience.\n\nPowered by AI. Built for the Niger Delta and beyond.\n\nFirst — what should I call you?"
        );
        return;
      }

      track(from, text.split(" ")[0]);
      trackRecentCommand(from, text.split(" ")[0]);

      // ── RETURNING USER EXPERIENCE (>48hrs away) ─────────────────────────────
      const hrsAway = hoursSince(lastSeen.get(from));
      if (hrsAway > 48 && (text === "hi" || text === "hello" || text === "hey" || text === "menu" || text === "help")) {
        const shown = await sendReturnExperience(from);
        if (shown) return;
      }

      lastSeen.set(from, Date.now());

      // ── COMMAND ROUTING ─────────────────────────────────────────────────────
      if (text === "news") {
        const items = await fetchRSSItems();
        await sendNewsItems(from, items.slice(0, 5), "📰 Top Stories");
        return;
      }

      if (text === "help" || text === "menu" || text === "hi" || text === "hello" || text === "hey" || text === "start") {
        await sendAdaptiveMenu(from);
        return;
      }

      if (text === "contact") {
        await sendMessage(from, "NaijaScope Media\n\n🌐 www.bayelsamedia.com.ng\n📧 admin@bayelsamedia.com.ng\n\nWe read everything. Don't be a stranger. 🇳🇬");
        return;
      }

      if (text === "subscribe") {
        subscribers.add(from);
        await sendMessage(from, "You're in. Daily digest every morning at 7AM WAT. Breaking alerts the moment news breaks.\n\nType 'alert me about [topic]' to add keyword alerts.");
        return;
      }

      if (text === "unsubscribe") {
        subscribers.delete(from);
        await sendMessage(from, "Unsubscribed. You can come back anytime — type 'subscribe'. No wahala.");
        return;
      }

      if (text === "trending") {
        const items = await fetchRSSItems();
        await sendNewsItems(from, items.slice(0, 3), "🔥 Trending on NaijaScope:");
        return;
      }

      if (text === "oil price" || text === "oil price today") {
        await sendMessage(from, await fetchOilPrice());
        return;
      }

      if (text === "dollar rate" || text === "exchange rate" || text === "naira rate") {
        await sendMessage(from, await fetchExchangeRate());
        return;
      }

      if (text === "flood alert" || text === "flood") {
        await sendMessage(from, await fetchFloodAlert());
        return;
      }

      if (text.startsWith("weather ")) {
        const city = rawText.slice(8).trim();
        if (!city) { await sendMessage(from, "Which city? Type: weather Yenagoa"); return; }
        await sendMessage(from, await fetchWeather(city));
        return;
      }

      if (text === "opportunities" || text === "jobs" || text === "scholarships") {
        const opps = await fetchOpportunities();
        if (opps) {
          await sendNewsItems(from, opps, "🎓 Opportunities on NaijaScope:");
          await sendMessage(from, "Type 'opportunity alerts' to get notified the moment new ones appear.");
        } else {
          await sendMessage(from, "Nothing in the feed right now. Check www.bayelsamedia.com.ng directly, or set an alert: opportunity alerts");
        }
        return;
      }

      if (text === "subscribe opportunities" || text === "opportunity alerts") {
        opportunitySubscribers.add(from);
        await sendMessage(from, "✅ Opportunity alerts active. You'll hear about scholarships, jobs, and grants the moment they're published.");
        return;
      }

      if (text === "football" || text === "super eagles" || text === "afcon") {
        await sendFootballExperience(from);
        return;
      }

      if (text === "discover" || text === "explore" || text === "topics") {
        await sendDiscoverMenu(from);
        return;
      }

      if (text === "pidgin on") {
        pidginMode.set(from, true);
        await sendMessage(from, "Pidgin mode don activate. Oya, make we begin! 🇳🇬");
        return;
      }

      if (text === "pidgin off") {
        pidginMode.set(from, false);
        await sendMessage(from, "Back to English. No wahala.");
        return;
      }

      if (text.startsWith("fact check ")) {
        const claim = rawText.slice(11).trim();
        if (!claim) { await sendMessage(from, "What should I check? Type: fact check [the claim]"); return; }
        await sendMessage(from, "🔍 Checking that now...");
        await sendMessage(from, await factCheck(claim));
        return;
      }

      if (text === "why" || text === "context" || text === "explain") {
        const recent = lastSentNews.get(from);
        if (!recent?.[0]) {
          await sendMessage(from, "Read a story first with 'news', then type 'why' for the context.");
          return;
        }
        await sendMessage(from, "Pulling context on that story...");
        await sendMessage(from, await getStoryExplainer(recent[0].title));
        return;
      }

      if (text === "election" || text === "2027 election") {
        const items = await getNewsByCategory("election");
        await sendNewsItems(from, items || [], "🗳️ 2027 Election Coverage:");
        return;
      }

      if (text === "nddc") {
        const items = await getNewsByCategory("nddc");
        await sendNewsItems(from, items || [], "📋 NDDC Coverage:");
        return;
      }

      if (Object.keys(CATEGORY_KEYWORDS).includes(text)) {
        const emoji = CATEGORY_EMOJI[text] || "📰";
        const items = await getNewsByCategory(text);
        await sendNewsItems(from, items || [], `${emoji} ${capitalize(text)} News:`);
        return;
      }

      if (text === "saved" || text === "bookmarks") {
        const saved = bookmarks.get(from) || [];
        if (saved.length === 0) {
          await sendMessage(from, "Nothing saved yet. After reading stories, tap 'Save Story' or type 'save'. 📌");
        } else {
          const list = saved.map((s, i) => `${i + 1}. ${s.title}\n${s.link}`).join("\n\n");
          await sendMessage(from, `📌 Saved Stories\n\n${list}`);
        }
        return;
      }

      const saveMatch = text.match(/^save\s*(\d*)$/);
      if (saveMatch) {
        const recent = lastSentNews.get(from);
        if (!recent?.length) { await sendMessage(from, "No recent story to save. Type 'news' first."); return; }
        const idx = saveMatch[1] ? parseInt(saveMatch[1], 10) - 1 : 0;
        const story = recent[Math.min(idx, recent.length - 1)];
        if (!bookmarks.has(from)) bookmarks.set(from, []);
        const saved = bookmarks.get(from);
        if (saved.some(s => s.link === story.link)) {
          await sendMessage(from, "Already saved. Type 'saved' to view your collection. 📌");
        } else {
          saved.push({ title: story.title, link: story.link });
          await sendMessage(from, `📌 Saved: ${story.title}`);
        }
        return;
      }

      if (text.startsWith("track ")) {
        await sendMessage(from, getPromises(rawText.slice(6).trim()));
        return;
      }

      if (text === "poll") {
        await sendMessage(from, getPollResults());
        return;
      }

      if (text === "send tip" || text === "tip") {
        tipsInProgress.set(from, { step: 1, data: {} });
        await sendMessage(from, "🔒 Anonymous Tipline\n\nYour identity is completely protected — we never store your number against your tip.\n\n📝 Step 1 of 3 — What is your tip about?");
        return;
      }

      if (text === "report" || text === "report story") {
        reportsInProgress.set(from, { step: 1, data: {} });
        await sendMessage(from, "📰 Citizen Reporter\n\nYou're about to submit a story to the NaijaScope newsroom. Our journalists review every submission.\n\n📝 Step 1 of 4 — What happened?");
        return;
      }

      if (text.startsWith("alert me about ")) {
        const keyword = rawText.slice(15).trim().toLowerCase();
        if (!keyword) { await sendMessage(from, "Alert about what? Try: alert me about NDDC"); return; }
        if (!userAlerts.has(from)) userAlerts.set(from, new Set());
        userAlerts.get(from).add(keyword);
        await sendMessage(from, `🔔 Alert set for "${keyword}". You'll be notified the moment it appears in NaijaScope news.`);
        return;
      }

      if (text === "my alerts") {
        const alerts = userAlerts.get(from);
        if (!alerts?.size) {
          await sendMessage(from, "No active alerts. Set one: alert me about [keyword]");
        } else {
          await sendMessage(from, `🔔 Your Alerts\n\n${[...alerts].map((k, i) => `${i + 1}. ${k}`).join("\n")}\n\nType 'remove alert [keyword]' to remove one.`);
        }
        return;
      }

      if (text.startsWith("remove alert ")) {
        const kw = rawText.slice(13).trim().toLowerCase();
        if (userAlerts.has(from)) {
          userAlerts.get(from).delete(kw);
          await sendMessage(from, `✅ Alert for "${kw}" removed.`);
        } else {
          await sendMessage(from, "No alerts to remove. Type 'my alerts' to check what's active.");
        }
        return;
      }

      if (text === "go premium" || text === "premium") {
        if (premiumUsers.has(from)) {
          await sendMessage(from, "🌟 You're already premium. Enjoy every edge, Chief. 👑");
        } else {
          await sendMessage(from, `🌟 NaijaScope Premium\n\n✅ Breaking news 30 mins early\n✅ Exclusive investigations\n✅ Priority AI responses\n✅ Deep-dive briefings\n\n₦500/month — contact admin@bayelsamedia.com.ng to join.\nwww.bayelsamedia.com.ng 👑`);
        }
        return;
      }

      // ── AI FALLBACK ─────────────────────────────────────────────────────────
      if (!checkRateLimit(from)) {
        await sendMessage(from, "Give me 3 seconds. 😄");
        return;
      }
      await sendMessage(from, await getAIResponse(from, rawText));

    } catch (err) {
      console.error("Webhook error:", err.message);
    }
  })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NaijaScope Media Bot running on port ${PORT}`);
  startDailyDigest();
  startDailyPoll();
  startBreakingNewsMonitor();
});
