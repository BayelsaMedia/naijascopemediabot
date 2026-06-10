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
  "You are the NaijaScope Media Bot — the smartest Nigerian news assistant alive. You work for NaijaScope Media (www.bayelsamedia.com.ng), specializing in Niger Delta, Bayelsa State, oil and gas, Nigerian politics and current affairs. Be conversational, witty, warm and Nigerian. Keep responses SHORT and PUNCHY — max 4 lines unless the user explicitly asks for detail. Feel like a real smart person texting, not a robot. Occasionally use Nigerian expressions naturally e.g. No wahala, Sharp sharp, E don happen, Abeg. Always end with a smart follow-up question or a call to action. Use plain text only, no asterisks or markdown. Never say you cannot help. Never say you are having a small issue — if something goes wrong say something witty instead.";

const SYSTEM_PROMPT_PIDGIN =
  "You are the NaijaScope Media Bot — the smartest Nigerian news assistant wey ever exist. You work for NaijaScope Media (www.bayelsamedia.com.ng). Respond ONLY in Nigerian Pidgin English. Be sharp, funny, warm and intelligent. Keep answers SHORT — max 4 lines. Use expressions like E don happen, Na so e be, Wetin you wan know, Abeg, Oya, No wahala. Use plain text only, no asterisks or markdown. Never say you cannot help.";

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

// ─── STATE ─────────────────────────────────────────────────────────────────────
const conversationHistory = new Map();
const processedMessageIds = new Set();
const pidginMode = new Map();
const subscribers = new Set();
const opportunitySubscribers = new Set();
const premiumUsers = new Set();
const userProfiles = new Map();
const bookmarks = new Map();
const lastSentNews = new Map();
const newsCache = new Map();
const rateLimit = new Map();
const knownUsers = new Set();
const pendingOnboarding = new Map();
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

const MAX_PROCESSED_IDS = 1000;
const MAX_CONVERSATION_USERS = 500;
const CACHE_TTL = 10 * 60 * 1000;
const RATE_LIMIT_MS = 3000;

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
  const hour = new Date().getUTCHours();
  analytics.peakHours[hour]++;
  if (command) {
    analytics.commandCounts.set(command, (analytics.commandCounts.get(command) || 0) + 1);
  }
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
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: buttons.map(b => ({
              type: "reply",
              reply: { id: b.id, title: b.title.slice(0, 20) },
            })),
          },
        },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (err) {
    console.error("sendInteractiveButtons error:", err?.response?.data || err.message);
    await sendMessage(to, bodyText + "\n\nType: news, help, contact, subscribe, or ask me anything!");
  }
}

async function sendListMessage(to, bodyText, buttonLabel, sections) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: bodyText },
          action: {
            button: buttonLabel.slice(0, 20),
            sections,
          },
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

// ─── VOICE TRANSCRIPTION (Feature 16) ─────────────────────────────────────────
async function transcribeAudio(mediaId) {
  const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);
  const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "mp4" : "mpeg";
  const groq = getGroq();
  const file = await toFile(buffer, `audio.${ext}`, { type: mimeType });
  const result = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3",
    language: "en",
  });
  return result.text;
}

// ─── IMAGE FACT-CHECK (Feature 17) ────────────────────────────────────────────
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
        { type: "text", text: "You are a Nigerian news fact-checker. Analyze this image. Start with REAL, FAKE, or UNVERIFIED. Then 2-3 sentences on visual indicators of authenticity or manipulation. Tag: NaijaScope Fact-Check. Plain text only." },
      ],
    }],
    max_tokens: 250,
  });
  return "📸 NaijaScope Fact-Check:\n\n" + completion.choices[0].message.content;
}

// ─── RSS FETCH ─────────────────────────────────────────────────────────────────
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
    await sendMessage(to, "No stories found right now. Check www.bayelsamedia.com.ng 🔗");
    return;
  }
  lastSentNews.set(to, items);
  const top = items.slice(0, 5);
  const rows = top.map((item, i) => ({
    id: `story_${i}`,
    title: (item.title || "Story").slice(0, 24),
    description: (item.link || "").slice(0, 72),
  }));
  const fallback = top.reduce((m, item, i) => m + `${i + 1}. ${item.title}\n🔗 ${item.link}\n\n`,
    (header || "📰 Latest from NaijaScope:") + "\n\n") + "www.bayelsamedia.com.ng 🇳🇬";
  try {
    await sendListMessage(to, header || "📰 Latest from NaijaScope:", "View Headlines", [{ title: "Top Stories", rows }]);
    const links = top.map((item, i) => `${i + 1}. ${item.link}`).join("\n");
    await sendMessage(to, `🔗 Story links:\n${links}`);
  } catch {
    await sendMessage(to, fallback);
  }
}

// ─── OIL PRICE ────────────────────────────────────────────────────────────────
async function fetchOilPrice() {
  try {
    const cached = getCache("oil_price");
    if (cached) return cached;
    const res = await axios.get(
      "https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=2d",
      { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const meta = res.data.chart.result[0].meta;
    const price = (meta.regularMarketPrice || 0).toFixed(2);
    const prev = (meta.chartPreviousClose || meta.regularMarketPrice || 0).toFixed(2);
    const diff = (price - prev).toFixed(2);
    const arrow = diff >= 0 ? "📈" : "📉";
    const msg = `🛢️ Brent Crude: $${price}/barrel ${arrow}\nChange today: ${diff >= 0 ? "+" : ""}${diff}\n\nThe Niger Delta is watching. Want oil sector news?`;
    setCache("oil_price", msg);
    return msg;
  } catch (err) {
    console.error("fetchOilPrice error:", err.message);
    return "Couldn't grab the oil price — market data dey form 😅\nType 'oil' for oil sector news.";
  }
}

// ─── EXCHANGE RATE (Feature 20) ───────────────────────────────────────────────
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
  } catch (err) {
    console.error("fetchExchangeRate error:", err.message);
    return "Couldn't fetch the exchange rate right now 😅\nCheck cbn.gov.ng for the official rate.";
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
    const msg = `🌤️ ${city} weather:\n${cur.weatherDesc[0].value}, ${cur.temp_C}°C (feels like ${cur.FeelsLikeC}°C)\nHumidity: ${cur.humidity}%\n\nStay safe! Anything else?`;
    setCache(cacheKey, msg);
    return msg;
  } catch (err) {
    console.error("fetchWeather error:", err.message);
    return `Couldn't get weather for ${city} right now 🌧️\nTry another city or check back soon.`;
  }
}

// ─── FLOOD ALERTS (Feature 21) ────────────────────────────────────────────────
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

    if (risk === "HIGH") {
      for (const number of subscribers) {
        await sendMessage(number, `🚨 FLOOD ALERT — Bayelsa State\n\n${msg}`);
        await new Promise(r => setTimeout(r, 600));
      }
    }
    return msg;
  } catch (err) {
    console.error("fetchFloodAlert error:", err.message);
    return "Couldn't fetch flood data right now 🌊\nMonitor BYSEMA and local authorities for updates.";
  }
}

// ─── OPPORTUNITIES (Feature 22) ───────────────────────────────────────────────
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
    if (profile?.category) sys += ` They prefer ${profile.category} news.`;
    if (premiumUsers.has(userId)) sys += " This is a premium user — give them priority detailed responses.";
    const messages = [{ role: "system", content: sys }, ...history, { role: "user", content: userMessage }];
    const completion = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages, max_tokens: 300 });
    const response = completion.choices[0].message.content;
    history.push({ role: "user", content: userMessage });
    history.push({ role: "assistant", content: response });
    if (history.length > 20) history.splice(0, history.length - 20);
    return response;
  } catch (err) {
    console.error("getAIResponse error:", err.message);
    return "Hmm, let me think on that — try again in a sec 🤔";
  }
}

async function factCheck(claim) {
  try {
    const groq = getGroq();
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "You are a Nigerian news fact-checker. Start with TRUE, FALSE, or UNVERIFIED. Then 2-3 sentences explanation. Direct, evidence-based. Plain text only." },
        { role: "user", content: `Fact check: ${claim}` },
      ],
      max_tokens: 200,
    });
    return completion.choices[0].message.content;
  } catch (err) {
    console.error("factCheck error:", err.message);
    return "Fact check dey sleep 😅 Try again in a sec.";
  }
}

// ─── DAILY POLL (Feature 24) ──────────────────────────────────────────────────
async function generateDailyPoll() {
  try {
    const groq = getGroq();
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: "Generate one sharp, topical opinion poll question about Nigerian politics, oil sector, or Niger Delta issues. Return ONLY a JSON object with fields: question (string), options (array of exactly 3 short strings, max 20 chars each). No markdown, no explanation.",
      }],
      max_tokens: 150,
    });
    const raw = completion.choices[0].message.content.trim();
    const json = JSON.parse(raw.replace(/```json?|```/g, "").trim());
    return { question: json.question, options: json.options.slice(0, 3) };
  } catch (err) {
    console.error("generateDailyPoll error:", err.message);
    return { question: "How do you rate the current government's handling of oil revenue in Bayelsa?", options: ["Excellent", "Average", "Poor"] };
  }
}

async function sendPollToSubscribers() {
  if (subscribers.size === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  if (pollData.date === today) return;
  const poll = await generateDailyPoll();
  pollData.date = today;
  pollData.question = poll.question;
  pollData.options = poll.options;
  pollData.votes = new Map();
  console.log(`[POLL] Sending daily poll to ${subscribers.size} subscribers`);
  for (const number of subscribers) {
    try {
      await sendInteractiveButtons(number, `📊 NaijaScope Daily Poll:\n\n${poll.question}`, [
        { id: `poll_0`, title: poll.options[0] },
        { id: `poll_1`, title: poll.options[1] },
        { id: `poll_2`, title: poll.options[2] },
      ]);
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      console.error("[POLL] send error:", err.message);
    }
  }
}

function getPollResults() {
  if (!pollData.question) return "No poll active today. Check back tomorrow! 📊";
  const total = pollData.votes.size;
  if (total === 0) return `📊 Today's Poll:\n\n${pollData.question}\n\nNo votes yet — be the first!`;
  const counts = [0, 0, 0];
  for (const v of pollData.votes.values()) counts[v]++;
  const lines = pollData.options.map((opt, i) => {
    const pct = total > 0 ? Math.round((counts[i] / total) * 100) : 0;
    return `${opt}: ${pct}% (${counts[i]} votes)`;
  }).join("\n");
  return `📊 Today's Poll:\n\n${pollData.question}\n\n${lines}\n\nTotal votes: ${total}`;
}

// ─── PROMISE TRACKER (Feature 23) ─────────────────────────────────────────────
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

// ─── KEYWORD ALERTS (Feature 26) ──────────────────────────────────────────────
async function checkKeywordAlerts(newItems) {
  if (newItems.length === 0 || userAlerts.size === 0) return;
  for (const [userId, keywords] of userAlerts) {
    for (const item of newItems) {
      const title = (item.title || "").toLowerCase();
      for (const kw of keywords) {
        if (title.includes(kw.toLowerCase())) {
          await sendMessage(userId, `🔔 Keyword Alert: "${kw}"\n\n${item.title}\n🔗 ${item.link}`);
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
  const text = rawText.trim();
  const upper = text.toUpperCase();

  if (upper.startsWith("BROADCAST ")) {
    const msg = rawText.slice(10).trim();
    if (!msg) { await sendMessage(from, "Usage: BROADCAST [message]"); return; }
    let sent = 0;
    for (const number of subscribers) {
      await sendMessage(number, `📢 NaijaScope Broadcast:\n\n${msg}`);
      await new Promise(r => setTimeout(r, 600));
      sent++;
    }
    await sendMessage(from, `✅ Broadcast sent to ${sent} subscribers.`);
    return;
  }

  if (upper.startsWith("BREAKING ON ")) {
    const topic = rawText.slice(12).trim();
    breakingLive.active = true;
    breakingLive.topic = topic;
    await sendMessage(from, `🔴 Live Breaking Mode ON — Topic: ${topic}\n\nSend updates as: LIVE [update text]`);
    for (const number of subscribers) {
      await sendMessage(number, `🔴 LIVE: NaijaScope is now providing live updates on:\n${topic}\n\nStay tuned! 📡`);
      await new Promise(r => setTimeout(r, 600));
    }
    return;
  }

  if (upper === "BREAKING OFF") {
    breakingLive.active = false;
    await sendMessage(from, `✅ Live Breaking Mode OFF. Topic "${breakingLive.topic}" closed.`);
    breakingLive.topic = "";
    return;
  }

  if (upper.startsWith("LIVE ") && breakingLive.active) {
    const update = rawText.slice(5).trim();
    let sent = 0;
    for (const number of subscribers) {
      await sendMessage(number, `🔴 LIVE UPDATE: ${breakingLive.topic}\n\n${update}\n\nNaijaScope Media | www.bayelsamedia.com.ng`);
      await new Promise(r => setTimeout(r, 600));
      sent++;
    }
    await sendMessage(from, `✅ Live update sent to ${sent} subscribers.`);
    return;
  }

  if (upper === "STATS") {
    const today = new Date().toISOString().slice(0, 10);
    const todayMsgs = analytics.messagesPerDay.get(today) || 0;
    const topCmds = [...analytics.commandCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([cmd, n]) => `${cmd}: ${n}`).join(", ");
    const peakHour = analytics.peakHours.indexOf(Math.max(...analytics.peakHours));
    await sendMessage(from,
      `📊 Bot Stats:\n\nTotal users: ${analytics.totalUsers.size}\nSubscribers: ${subscribers.size}\nPremium: ${premiumUsers.size}\nMessages today: ${todayMsgs}\nTop commands: ${topCmds || "none"}\nPeak hour: ${peakHour}:00 UTC\nLive mode: ${breakingLive.active ? "ON — " + breakingLive.topic : "OFF"}`
    );
    return;
  }

  if (upper.startsWith("ADD PROMISE ")) {
    const parts = rawText.slice(12).split("|");
    if (parts.length < 2) { await sendMessage(from, "Usage: ADD PROMISE [politician] | [promise text]"); return; }
    const politician = parts[0].trim().toLowerCase();
    const promise = parts[1].trim();
    const status = parts[2]?.trim() || "PENDING";
    if (!promiseTracker.has(politician)) promiseTracker.set(politician, []);
    promiseTracker.get(politician).push({ promise, status, date: new Date().toISOString().slice(0, 10) });
    await sendMessage(from, `✅ Promise added for ${politician}:\n"${promise}" — ${status}`);
    return;
  }

  if (upper.startsWith("UPDATE PROMISE ")) {
    const parts = rawText.slice(15).split("|");
    if (parts.length < 3) { await sendMessage(from, "Usage: UPDATE PROMISE [politician] | [index] | [KEPT/BROKEN/PENDING]"); return; }
    const politician = parts[0].trim().toLowerCase();
    const idx = parseInt(parts[1].trim()) - 1;
    const newStatus = parts[2].trim().toUpperCase();
    const promises = promiseTracker.get(politician);
    if (!promises || !promises[idx]) { await sendMessage(from, "Promise not found."); return; }
    promises[idx].status = newStatus;
    await sendMessage(from, `✅ Updated: "${promises[idx].promise}" → ${newStatus}`);
    return;
  }
}

// ─── WELCOME MENU ──────────────────────────────────────────────────────────────
async function sendWelcomeMenu(to) {
  const body = `👋 Hey! NaijaScope Media Bot — Nigeria's smartest news assistant.\n\nWhat do you need?`;
  await sendInteractiveButtons(to, body, [
    { id: "btn_news", title: "📰 Top News" },
    { id: "btn_ask", title: "🤖 Ask AI" },
    { id: "btn_subscribe", title: "📡 Subscribe" },
  ]);
}

// ─── ONBOARDING ────────────────────────────────────────────────────────────────
async function runOnboarding(from, text) {
  const step = pendingOnboarding.get(from);
  if (step === "category") {
    const cats = Object.keys(CATEGORY_KEYWORDS);
    const category = cats.find(c => text.toLowerCase().includes(c)) || "general";
    const profile = userProfiles.get(from) || {};
    userProfiles.set(from, { ...profile, category, onboarded: true });
    pendingOnboarding.delete(from);
    knownUsers.add(from);
    await sendMessage(from, `Sharp sharp! 🎯 I'll keep you on top of ${category} news.\n\nType 'news' for headlines, 'help' for all commands, or just ask me anything. No wahala! 🇳🇬`);
    return true;
  }
  return false;
}

// ─── TIP FLOW (Feature 18) ────────────────────────────────────────────────────
async function runTipFlow(from, text, rawText) {
  const flow = tipsInProgress.get(from);
  if (flow.step === 1) {
    flow.data.about = rawText;
    flow.step = 2;
    await sendMessage(from, "📍 Step 2 of 3: Which location does this involve? (City/LGA/Community)");
    return true;
  }
  if (flow.step === 2) {
    flow.data.location = rawText;
    flow.step = 3;
    await sendMessage(from, "📎 Step 3 of 3: Any evidence? Send a photo or type 'none'");
    return true;
  }
  if (flow.step === 3) {
    flow.data.evidence = text === "none" ? "No evidence provided" : rawText;
    tips.push({ ...flow.data, timestamp: new Date().toISOString(), from: "anonymous" });
    tipsInProgress.delete(from);
    console.log(`[TIP] New anonymous tip: ${JSON.stringify(flow.data)}`);
    await sendMessage(from, "✅ Your tip has been submitted anonymously to NaijaScope Media.\n\nThank you for speaking up! Your identity is fully protected. 🔒");
    if (ADMIN_NUMBER) {
      await sendMessage(ADMIN_NUMBER, `🔔 New Anonymous Tip:\n\nAbout: ${flow.data.about}\nLocation: ${flow.data.location}\nEvidence: ${flow.data.evidence}\nTime: ${new Date().toLocaleString("en-NG", { timeZone: "Africa/Lagos" })}`);
    }
    return true;
  }
  return false;
}

// ─── REPORT FLOW (Feature 25) ─────────────────────────────────────────────────
async function runReportFlow(from, rawText) {
  const flow = reportsInProgress.get(from);
  if (flow.step === 1) {
    flow.data.what = rawText;
    flow.step = 2;
    await sendMessage(from, "📍 Step 2 of 4: Where exactly did this happen? (Location)");
    return true;
  }
  if (flow.step === 2) {
    flow.data.where = rawText;
    flow.step = 3;
    await sendMessage(from, "🕐 Step 3 of 4: When did this happen? (Date/time)");
    return true;
  }
  if (flow.step === 3) {
    flow.data.when = rawText;
    flow.step = 4;
    await sendMessage(from, "📷 Step 4 of 4: Send a photo if you have one, or type 'none'");
    return true;
  }
  if (flow.step === 4) {
    flow.data.photo = rawText.toLowerCase() === "none" ? "No photo" : "Photo submitted";
    reports.push({ ...flow.data, timestamp: new Date().toISOString() });
    reportsInProgress.delete(from);
    console.log(`[REPORT] New citizen report: ${JSON.stringify(flow.data)}`);
    await sendMessage(from, "✅ Story submitted to the NaijaScope newsroom!\n\nOur journalists will review your report. Thank you for being a citizen journalist! 📰🇳🇬");
    if (ADMIN_NUMBER) {
      await sendMessage(ADMIN_NUMBER, `📰 New Citizen Report:\n\nWhat: ${flow.data.what}\nWhere: ${flow.data.where}\nWhen: ${flow.data.when}\nPhoto: ${flow.data.photo}\nTime: ${new Date().toLocaleString("en-NG", { timeZone: "Africa/Lagos" })}`);
    }
    return true;
  }
  return false;
}

// ─── BACKGROUND JOBS ──────────────────────────────────────────────────────────
function startDailyDigest() {
  setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() === 6 && now.getUTCMinutes() < 5 && subscribers.size > 0) {
      console.log(`[DIGEST] Sending to ${subscribers.size} subscribers`);
      try {
        const items = await fetchRSSItems(true);
        for (const number of subscribers) {
          await sendMessage(number, "🌅 Good morning! Your NaijaScope daily digest 📰");
          await sendNewsItems(number, items.slice(0, 5), "Top 5 stories today:");
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
          const alert = `🔴 BREAKING: ${item.title}\n🔗 ${item.link}\n\nNaijaScope Media | www.bayelsamedia.com.ng`;
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
      console.log(`[${new Date().toISOString()}] from=${from} type=${message.type}`);

      // ── Interactive replies ──────────────────────────────────────────────
      if (message.type === "interactive") {
        const replyId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
        if (replyId === "btn_news") {
          track(from, "news");
          const items = await fetchRSSItems();
          await sendNewsItems(from, items.slice(0, 5), "📰 Top stories right now:");
        } else if (replyId === "btn_ask") {
          await sendMessage(from, "Ask me anything about Nigeria, Niger Delta, politics, oil or current affairs! 🤖");
        } else if (replyId === "btn_subscribe") {
          subscribers.add(from);
          track(from, "subscribe");
          await sendMessage(from, "✅ Subscribed! Daily headlines at 7AM WAT + breaking news alerts. Sharp sharp! 📡\n\nType 'unsubscribe' anytime.");
        } else if (replyId?.startsWith("poll_")) {
          const optIdx = parseInt(replyId.split("_")[1]);
          if (pollData.question && optIdx >= 0 && optIdx < pollData.options.length) {
            pollData.votes.set(from, optIdx);
            await sendMessage(from, `✅ Vote recorded for: "${pollData.options[optIdx]}"\n\nType 'poll' to see current results!`);
          }
        }
        return;
      }

      // ── Image messages (Feature 17) ──────────────────────────────────────
      if (message.type === "image") {
        const mediaId = message.image?.id;
        if (mediaId) {
          await sendMessage(from, "📸 Analyzing your image...");
          try {
            const result = await analyzeImage(mediaId);
            await sendMessage(from, result);
          } catch (err) {
            console.error("analyzeImage error:", err.message);
            await sendMessage(from, "📸 Couldn't analyze that image right now. Try again or describe what you see! 🤔");
          }
        } else {
          await sendMessage(from, "📷 Got your image! Describe what you need and I'll help 👇");
        }
        return;
      }

      // ── Audio messages (Feature 16) ──────────────────────────────────────
      if (message.type === "audio") {
        const mediaId = message.audio?.id;
        if (mediaId) {
          await sendMessage(from, "🎤 Transcribing your voice note...");
          try {
            const transcription = await transcribeAudio(mediaId);
            await sendMessage(from, `🎤 Got your voice note! Here's what I heard:\n"${transcription}"\n\nProcessing...`);
            if (!checkRateLimit(from)) {
              await sendMessage(from, "Easy now! Give me 3 seconds 😄");
              return;
            }
            const reply = await getAIResponse(from, transcription);
            await sendMessage(from, reply);
          } catch (err) {
            console.error("transcribeAudio error:", err.message);
            await sendMessage(from, "🎤 Couldn't transcribe that voice note. Please type your message instead! 👇");
          }
        } else {
          await sendMessage(from, "🎤 Voice note received! Type your question and I'm on it 👇");
        }
        return;
      }

      if (message.type !== "text" || !message.text?.body) return;
      const rawText = message.text.body.trim();
      const text = rawText.toLowerCase();

      // ── Active flows ─────────────────────────────────────────────────────
      if (tipsInProgress.has(from)) {
        await runTipFlow(from, text, rawText);
        return;
      }
      if (reportsInProgress.has(from)) {
        await runReportFlow(from, rawText);
        return;
      }
      if (pendingOnboarding.has(from)) {
        const handled = await runOnboarding(from, rawText);
        if (handled) return;
      }

      // ── Admin commands ───────────────────────────────────────────────────
      if (isAdmin(from)) {
        const upper = rawText.toUpperCase();
        if (upper.startsWith("BROADCAST ") || upper.startsWith("BREAKING ") ||
            upper === "BREAKING OFF" || upper === "STATS" ||
            upper.startsWith("ADD PROMISE ") || upper.startsWith("UPDATE PROMISE ") ||
            (upper.startsWith("LIVE ") && breakingLive.active)) {
          await handleAdminCommand(from, rawText);
          return;
        }
      }

      // ── First-time user ──────────────────────────────────────────────────
      if (!knownUsers.has(from)) {
        knownUsers.add(from);
        pendingOnboarding.set(from, "category");
        await sendMessage(from, "👋 Welcome to NaijaScope Media Bot — Nigeria's smartest news assistant!\n\nWhat news category interests you most?\n\nReply: politics, oil, sports, entertainment, crime, or environment");
        return;
      }

      // ── Commands ─────────────────────────────────────────────────────────
      track(from, text.split(" ")[0]);

      if (text === "news") {
        const items = await fetchRSSItems();
        await sendNewsItems(from, items.slice(0, 5), "📰 Top stories right now:");
        return;
      }
      if (text === "help" || text === "menu") { await sendWelcomeMenu(from); return; }
      if (text === "contact") {
        await sendMessage(from, "📞 NaijaScope Media:\n\n🌐 www.bayelsamedia.com.ng\n📧 admin@bayelsamedia.com.ng\n\nWe'd love to hear from you! 🇳🇬");
        return;
      }
      if (text === "subscribe") {
        subscribers.add(from);
        await sendMessage(from, "✅ Subscribed! Daily headlines at 7AM WAT + breaking news alerts. No wahala! 📡\n\nType 'unsubscribe' anytime.");
        return;
      }
      if (text === "unsubscribe") {
        subscribers.delete(from);
        await sendMessage(from, "👋 Unsubscribed. No more daily digests.\n\nType 'subscribe' anytime to rejoin. E don happen!");
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
        if (!city) { await sendMessage(from, "Which city? E.g: weather Yenagoa"); return; }
        await sendMessage(from, await fetchWeather(city));
        return;
      }
      if (text === "opportunities" || text === "jobs" || text === "scholarships") {
        const opps = await fetchOpportunities();
        if (opps) {
          await sendNewsItems(from, opps, "🎓 Latest opportunities:");
        } else {
          await sendMessage(from, "No opportunities in our feed right now.\n\nCheck www.bayelsamedia.com.ng directly for the latest! 🔗");
        }
        return;
      }
      if (text === "subscribe opportunities" || text === "opportunity alerts") {
        opportunitySubscribers.add(from);
        await sendMessage(from, "✅ Subscribed to opportunity alerts! I'll notify you of scholarships and jobs. Sharp sharp! 🎓");
        return;
      }
      if (text === "pidgin on") { pidginMode.set(from, true); await sendMessage(from, "Oya! Pidgin mode don activate 🇳🇬"); return; }
      if (text === "pidgin off") { pidginMode.set(from, false); await sendMessage(from, "Pidgin mode off. Back to English! ✅"); return; }
      if (text.startsWith("fact check ")) {
        const claim = rawText.slice(11).trim();
        await sendMessage(from, "🔍 Checking that fact...");
        await sendMessage(from, await factCheck(claim));
        return;
      }
      if (text === "election" || text === "2027 election") {
        await sendNewsItems(from, await getNewsByCategory("election") || [], "🗳️ 2027 Election updates:");
        return;
      }
      if (text === "nddc") {
        await sendNewsItems(from, await getNewsByCategory("nddc") || [], "📋 NDDC Tracker:");
        return;
      }
      if (Object.keys(CATEGORY_KEYWORDS).includes(text)) {
        await sendNewsItems(from, await getNewsByCategory(text) || [], `📰 Latest ${text} news:`);
        return;
      }
      if (text === "saved" || text === "bookmarks") {
        const saved = bookmarks.get(from) || [];
        if (saved.length === 0) {
          await sendMessage(from, "No saved stories yet. Type 'save 1' after getting headlines to bookmark! 📌");
        } else {
          await sendMessage(from, saved.reduce((m, s, i) => m + `${i + 1}. ${s.title}\n🔗 ${s.link}\n\n`, "📌 Saved stories:\n\n").trim());
        }
        return;
      }
      const saveMatch = text.match(/^save\s*(\d*)$/);
      if (saveMatch) {
        const recent = lastSentNews.get(from);
        if (!recent?.length) { await sendMessage(from, "No recent story to save. Type 'news' first! 📰"); return; }
        const idx = saveMatch[1] ? parseInt(saveMatch[1], 10) - 1 : 0;
        const story = recent[Math.min(idx, recent.length - 1)];
        if (!bookmarks.has(from)) bookmarks.set(from, []);
        const saved = bookmarks.get(from);
        if (saved.some(s => s.link === story.link)) {
          await sendMessage(from, "Already saved that one 📌 Type 'saved' to see your bookmarks.");
        } else {
          saved.push({ title: story.title, link: story.link });
          await sendMessage(from, `📌 Saved: ${story.title}\n\nType 'saved' to see all bookmarks.`);
        }
        return;
      }
      if (text.startsWith("track ")) {
        const politician = rawText.slice(6).trim();
        await sendMessage(from, getPromises(politician));
        return;
      }
      if (text === "poll") {
        await sendMessage(from, getPollResults());
        return;
      }
      if (text === "send tip" || text === "tip") {
        tipsInProgress.set(from, { step: 1, data: { about: "", location: "", evidence: "" } });
        await sendMessage(from, "🔒 Anonymous Tipline — your identity is fully protected.\n\n📝 Step 1 of 3: What is your tip about? Describe the issue.");
        return;
      }
      if (text === "report" || text === "report story") {
        reportsInProgress.set(from, { step: 1, data: { what: "", where: "", when: "", photo: "" } });
        await sendMessage(from, "📰 Citizen Reporter — Submit a story to the NaijaScope newsroom.\n\n📝 Step 1 of 4: What happened? Describe the event.");
        return;
      }
      if (text.startsWith("alert me about ")) {
        const keyword = rawText.slice(15).trim().toLowerCase();
        if (!keyword) { await sendMessage(from, "About what? E.g: alert me about NDDC"); return; }
        if (!userAlerts.has(from)) userAlerts.set(from, new Set());
        userAlerts.get(from).add(keyword);
        await sendMessage(from, `🔔 Alert set! I'll notify you whenever "${keyword}" appears in NaijaScope news. No wahala!`);
        return;
      }
      if (text === "my alerts") {
        const alerts = userAlerts.get(from);
        if (!alerts || alerts.size === 0) {
          await sendMessage(from, "No active alerts. Set one with: alert me about [keyword]");
        } else {
          await sendMessage(from, `🔔 Your active alerts:\n\n${[...alerts].map((k, i) => `${i + 1}. ${k}`).join("\n")}\n\nType 'remove alert [keyword]' to delete one.`);
        }
        return;
      }
      if (text.startsWith("remove alert ")) {
        const keyword = rawText.slice(13).trim().toLowerCase();
        if (userAlerts.has(from)) {
          userAlerts.get(from).delete(keyword);
          await sendMessage(from, `✅ Alert for "${keyword}" removed.`);
        } else {
          await sendMessage(from, "No alerts found to remove.");
        }
        return;
      }
      if (text === "go premium" || text === "premium") {
        if (premiumUsers.has(from)) {
          await sendMessage(from, "🌟 You're already a premium subscriber! Enjoy the benefits:\n\n✅ Breaking news priority\n✅ Exclusive investigations\n✅ Priority AI responses\n\nNo wahala, Chief! 👑");
        } else {
          await sendMessage(from, `🌟 NaijaScope Premium — ₦500/month\n\n✅ Breaking news 30 mins early\n✅ Exclusive investigations\n✅ Ad-free experience\n✅ Priority AI responses\n\nTo subscribe, contact: admin@bayelsamedia.com.ng or visit www.bayelsamedia.com.ng\n\nE don happen! 👑`);
        }
        return;
      }

      // ── Rate limit AI ────────────────────────────────────────────────────
      if (!checkRateLimit(from)) {
        await sendMessage(from, "Easy now! Give me 3 seconds between questions 😄");
        return;
      }

      // ── Default: AI ──────────────────────────────────────────────────────
      const reply = await getAIResponse(from, rawText);
      await sendMessage(from, reply);

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
