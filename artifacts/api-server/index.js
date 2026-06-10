import express from "express";
import axios from "axios";
import Groq from "groq-sdk";
import RSSParser from "rss-parser";

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const SYSTEM_PROMPT =
  "You are the NaijaScope Media Bot — the smartest Nigerian news assistant alive. You work for NaijaScope Media (www.bayelsamedia.com.ng), specializing in Niger Delta, Bayelsa State, oil and gas, Nigerian politics and current affairs. Be conversational, witty, warm and Nigerian. Keep responses SHORT and PUNCHY — max 4 lines unless the user explicitly asks for detail. Feel like a real smart person texting, not a robot. Occasionally use Nigerian expressions naturally e.g. No wahala, Sharp sharp, E don happen, Abeg. Always end with a smart follow-up question or a call to action. Use plain text only, no asterisks or markdown. Never say you cannot help. Never say you are having a small issue — if something goes wrong say something intelligent instead.";

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
};

const rssParser = new RSSParser();

// ─── STATE ─────────────────────────────────────────────────────────────────────
const conversationHistory = new Map();
const processedMessageIds = new Set();
const pidginMode = new Map();
const subscribers = new Set();
const userProfiles = new Map();
const bookmarks = new Map();
const lastSentNews = new Map();
const newsCache = new Map();
const rateLimit = new Map();
const knownUsers = new Set();
const pendingOnboarding = new Map();
const seenNewsLinks = new Set();

const MAX_PROCESSED_IDS = 1000;
const MAX_CONVERSATION_USERS = 500;
const CACHE_TTL = 10 * 60 * 1000;
const RATE_LIMIT_MS = 3000;

// ─── GROQ ──────────────────────────────────────────────────────────────────────
function getGroq() {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set");
  return new Groq({ apiKey: GROQ_API_KEY });
}

// ─── CACHE ─────────────────────────────────────────────────────────────────────
function getCache(key) {
  const entry = newsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) { newsCache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) {
  newsCache.set(key, { data, timestamp: Date.now() });
}

// ─── RATE LIMITING ─────────────────────────────────────────────────────────────
function checkRateLimit(userId) {
  const last = rateLimit.get(userId);
  if (last && Date.now() - last < RATE_LIMIT_MS) return false;
  rateLimit.set(userId, Date.now());
  return true;
}

// ─── DEDUPLICATION ─────────────────────────────────────────────────────────────
function trackMessageId(messageId) {
  if (processedMessageIds.has(messageId)) return false;
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > MAX_PROCESSED_IDS) {
    processedMessageIds.delete(processedMessageIds.values().next().value);
  }
  return true;
}

// ─── XML SANITIZATION ──────────────────────────────────────────────────────────
function sanitizeXml(raw) {
  return raw
    .replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFE\uFFFF]/g, "");
}

// ─── WHATSAPP SENDERS ──────────────────────────────────────────────────────────
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
        to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: bodyText },
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
  } catch (err) {
    console.error("markAsRead error:", err?.response?.data || err.message);
  }
}

// ─── RSS FETCH ─────────────────────────────────────────────────────────────────
async function fetchRSSItems(bypassCache = false) {
  if (!bypassCache) {
    const cached = getCache("rss_all");
    if (cached) return cached;
  }
  const response = await axios.get("https://www.bayelsamedia.com.ng/feed", {
    responseType: "text",
    timeout: 10000,
  });
  const xml = sanitizeXml(response.data);
  const feed = await rssParser.parseString(xml);
  setCache("rss_all", feed.items);
  return feed.items;
}

// ─── SEND NEWS HELPER ──────────────────────────────────────────────────────────
async function sendNewsItems(to, items, header) {
  if (!items || items.length === 0) {
    await sendMessage(to, "No stories found right now. Check www.bayelsamedia.com.ng directly 🔗");
    return;
  }

  lastSentNews.set(to, items);

  const rows = items.slice(0, 5).map((item, i) => ({
    id: `story_${i}`,
    title: (item.title || "Story").slice(0, 24),
    description: (item.link || "").slice(0, 72),
  }));

  const fallbackText = items.slice(0, 5).reduce((msg, item, i) => {
    return msg + `${i + 1}. ${item.title}\n🔗 ${item.link}\n\n`;
  }, (header || "📰 Latest from NaijaScope Media:") + "\n\n") + "www.bayelsamedia.com.ng 🇳🇬";

  try {
    await sendListMessage(
      to,
      header || "📰 Latest from NaijaScope Media:",
      "View Headlines",
      [{ title: "Top Stories", rows }]
    );
    const links = items.slice(0, 5).map((item, i) => `${i + 1}. ${item.link}`).join("\n");
    await sendMessage(to, `🔗 Story links:\n${links}`);
  } catch {
    await sendMessage(to, fallbackText);
  }
}

// ─── FEATURES ──────────────────────────────────────────────────────────────────
async function getNewsByCategory(category) {
  try {
    const cached = getCache(`cat_${category}`);
    if (cached) return cached;

    const items = await fetchRSSItems();
    const kws = CATEGORY_KEYWORDS[category] || [category];
    const filtered = items.filter(item =>
      kws.some(kw => (item.title || "").toLowerCase().includes(kw.toLowerCase()))
    );
    const result = (filtered.length > 0 ? filtered : items).slice(0, 3);
    setCache(`cat_${category}`, result);
    return result;
  } catch (err) {
    console.error("getNewsByCategory error:", err.message);
    return null;
  }
}

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
    return "Couldn't grab the oil price right now — market data dey form 😅\nTry again shortly or type 'oil' for oil sector news.";
  }
}

async function fetchWeather(city) {
  try {
    const cacheKey = `weather_${city.toLowerCase()}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    const res = await axios.get(
      `https://wttr.in/${encodeURIComponent(city)}?format=j1`,
      { timeout: 8000 }
    );
    const cur = res.data.current_condition[0];
    const desc = cur.weatherDesc[0].value;
    const temp = cur.temp_C;
    const feels = cur.FeelsLikeC;
    const humidity = cur.humidity;
    const msg = `🌤️ ${city} weather:\n${desc}, ${temp}°C (feels like ${feels}°C)\nHumidity: ${humidity}%\n\nStay safe out there! Anything else?`;
    setCache(cacheKey, msg);
    return msg;
  } catch (err) {
    console.error("fetchWeather error:", err.message);
    return `Couldn't get weather for ${city} right now 🌧️\nCheck back soon or try another city.`;
  }
}

async function getAIResponse(userId, userMessage) {
  try {
    const groq = getGroq();
    const isPidgin = pidginMode.get(userId) || false;
    const profile = userProfiles.get(userId);

    if (!conversationHistory.has(userId)) {
      conversationHistory.set(userId, []);
      if (conversationHistory.size > MAX_CONVERSATION_USERS) {
        conversationHistory.delete(conversationHistory.keys().next().value);
      }
    }
    const history = conversationHistory.get(userId);

    let systemPrompt = isPidgin ? SYSTEM_PROMPT_PIDGIN : SYSTEM_PROMPT;
    if (profile?.name) systemPrompt += ` The user's name is ${profile.name}.`;
    if (profile?.category) systemPrompt += ` They prefer ${profile.category} news.`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userMessage },
    ];

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      max_tokens: 300,
    });

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
        {
          role: "system",
          content: "You are a Nigerian news fact-checker. Analyze the claim and start your reply with TRUE, FALSE, or UNVERIFIED. Then give 2-3 sentences of explanation. Be direct, evidence-based. Plain text only.",
        },
        { role: "user", content: `Fact check: ${claim}` },
      ],
      max_tokens: 200,
    });
    return completion.choices[0].message.content;
  } catch (err) {
    console.error("factCheck error:", err.message);
    return "Fact check dey sleep right now 😅 Try again in a sec.";
  }
}

// ─── WELCOME MENU ──────────────────────────────────────────────────────────────
async function sendWelcomeMenu(to) {
  const profile = userProfiles.get(to);
  const name = profile?.name ? `, ${profile.name}` : "";
  const body = `👋 Hey${name}! NaijaScope Media Bot here — Nigeria's smartest news assistant.\n\nWhat do you need right now?`;
  await sendInteractiveButtons(to, body, [
    { id: "btn_news", title: "📰 Top News" },
    { id: "btn_ask", title: "🤖 Ask AI" },
    { id: "btn_subscribe", title: "📡 Subscribe" },
  ]);
}

// ─── ONBOARDING ────────────────────────────────────────────────────────────────
async function runOnboarding(from, text) {
  const step = pendingOnboarding.get(from);

  if (step === "name") {
    const name = text.trim().split(/\s+/)[0];
    userProfiles.set(from, { name, onboarded: false });
    pendingOnboarding.set(from, "category");
    await sendMessage(from, `Nice to meet you, ${name}! 🙌\n\nWhat kind of news interests you most?\n\nReply: politics, oil, sports, entertainment, crime, or environment`);
    return true;
  }

  if (step === "category") {
    const cats = Object.keys(CATEGORY_KEYWORDS);
    const category = cats.find(c => text.toLowerCase().includes(c)) || "general";
    const profile = userProfiles.get(from) || {};
    userProfiles.set(from, { ...profile, category, onboarded: true });
    pendingOnboarding.delete(from);
    knownUsers.add(from);
    const name = profile.name || "Chief";
    await sendMessage(from, `Sharp sharp, ${name}! 🎯 I'll prioritize ${category} news for you.\n\nType 'news' for headlines, 'help' for all commands, or just ask me anything. No wahala! 🇳🇬`);
    return true;
  }

  return false;
}

// ─── DAILY DIGEST ──────────────────────────────────────────────────────────────
function startDailyDigest() {
  setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() === 6 && now.getUTCMinutes() < 5 && subscribers.size > 0) {
      console.log(`[DIGEST] Sending to ${subscribers.size} subscribers`);
      try {
        const items = await fetchRSSItems(true);
        for (const number of subscribers) {
          await sendMessage(number, "🌅 Good morning! Your NaijaScope daily digest is here 📰");
          await sendNewsItems(number, items.slice(0, 5), "Top 5 stories today:");
          await new Promise(r => setTimeout(r, 1200));
        }
      } catch (err) {
        console.error("[DIGEST] error:", err.message);
      }
    }
  }, 5 * 60 * 1000);
}

// ─── BREAKING NEWS MONITOR ──────────────────────────────────────────────────────
function startBreakingNewsMonitor() {
  fetchRSSItems().then(items => {
    items.slice(0, 15).forEach(item => seenNewsLinks.add(item.link));
  }).catch(() => {});

  setInterval(async () => {
    if (subscribers.size === 0) return;
    try {
      const items = await fetchRSSItems(true);
      const fresh = items.filter(item => !seenNewsLinks.has(item.link));
      if (fresh.length === 0) return;

      fresh.forEach(item => seenNewsLinks.add(item.link));
      if (seenNewsLinks.size > 300) {
        const arr = [...seenNewsLinks];
        arr.slice(0, arr.length - 150).forEach(l => seenNewsLinks.delete(l));
      }

      for (const item of fresh.slice(0, 2)) {
        const alert = `🔴 BREAKING: ${item.title}\n🔗 ${item.link}\n\nNaijaScope Media | www.bayelsamedia.com.ng`;
        for (const number of subscribers) {
          await sendMessage(number, alert);
          await new Promise(r => setTimeout(r, 600));
        }
      }
    } catch (err) {
      console.error("[BREAKING NEWS] error:", err.message);
    }
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

      if (!trackMessageId(messageId)) {
        console.log(`[SKIP] Duplicate: ${messageId}`);
        return;
      }

      await markAsRead(messageId);
      console.log(`[${new Date().toISOString()}] from=${from} type=${message.type}`);

      // ── Interactive button/list replies ────────────────────────────────────
      if (message.type === "interactive") {
        const replyId =
          message.interactive?.button_reply?.id ||
          message.interactive?.list_reply?.id;
        if (replyId === "btn_news") {
          const items = await fetchRSSItems();
          await sendNewsItems(from, items.slice(0, 5), "📰 Top stories right now:");
        } else if (replyId === "btn_ask") {
          await sendMessage(from, "Go ahead — ask me anything about Nigeria, Niger Delta, politics, oil or current affairs! 🤖");
        } else if (replyId === "btn_subscribe") {
          subscribers.add(from);
          await sendMessage(from, "✅ Subscribed! Daily headlines hit your WhatsApp every morning at 7AM WAT.\n\nType 'unsubscribe' anytime. Sharp sharp! 📡");
        }
        return;
      }

      // ── Media ──────────────────────────────────────────────────────────────
      if (message.type === "image") {
        await sendMessage(from, "📷 Got your image! Describe what you need and I'll help 👇");
        return;
      }
      if (message.type === "audio") {
        await sendMessage(from, "🎤 Voice note received! Type your question and I'm on it 👇");
        return;
      }
      if (message.type !== "text" || !message.text?.body) return;

      const rawText = message.text.body.trim();
      const text = rawText.toLowerCase();

      // ── Onboarding flow ────────────────────────────────────────────────────
      if (pendingOnboarding.has(from)) {
        const handled = await runOnboarding(from, rawText);
        if (handled) return;
      }

      // ── First-time user ────────────────────────────────────────────────────
      if (!knownUsers.has(from)) {
        knownUsers.add(from);
        pendingOnboarding.set(from, "name");
        await sendMessage(from, "👋 Welcome to NaijaScope Media Bot — Nigeria's smartest news assistant!\n\nFirst things first — what's your name?");
        return;
      }

      // ── Commands ───────────────────────────────────────────────────────────
      if (text === "news") {
        const items = await fetchRSSItems();
        await sendNewsItems(from, items.slice(0, 5), "📰 Top stories right now:");
        return;
      }

      if (text === "help" || text === "menu") {
        await sendWelcomeMenu(from);
        return;
      }

      if (text === "contact") {
        await sendMessage(from, "📞 NaijaScope Media:\n\n🌐 www.bayelsamedia.com.ng\n📧 admin@bayelsamedia.com.ng\n\nWe'd love to hear from you! 🇳🇬");
        return;
      }

      if (text === "subscribe") {
        subscribers.add(from);
        await sendMessage(from, "✅ Subscribed! Daily headlines hit your WhatsApp every morning at 7AM WAT. No wahala! 📡\n\nType 'unsubscribe' anytime.");
        return;
      }

      if (text === "unsubscribe") {
        subscribers.delete(from);
        await sendMessage(from, "👋 You're unsubscribed. No more daily digests.\n\nType 'subscribe' anytime to rejoin. E don happen!");
        return;
      }

      if (text === "trending") {
        const items = await fetchRSSItems();
        await sendNewsItems(from, items.slice(0, 3), "🔥 Trending on NaijaScope right now:");
        return;
      }

      if (text === "oil price" || text === "oil price today") {
        const msg = await fetchOilPrice();
        await sendMessage(from, msg);
        return;
      }

      if (text.startsWith("weather ")) {
        const city = rawText.slice(8).trim();
        if (!city) { await sendMessage(from, "Which city? Type: weather Yenagoa"); return; }
        const msg = await fetchWeather(city);
        await sendMessage(from, msg);
        return;
      }

      if (text === "pidgin on") {
        pidginMode.set(from, true);
        await sendMessage(from, "Oya! Pidgin mode don activate. Na so we dey roll now! 🇳🇬");
        return;
      }

      if (text === "pidgin off") {
        pidginMode.set(from, false);
        await sendMessage(from, "Pidgin mode off. Back to English — sharp sharp! ✅");
        return;
      }

      if (text.startsWith("fact check ")) {
        const claim = rawText.slice(11).trim();
        if (!claim) { await sendMessage(from, "What claim? Type: fact check [your claim]"); return; }
        await sendMessage(from, "🔍 Checking that fact...");
        const verdict = await factCheck(claim);
        await sendMessage(from, verdict);
        return;
      }

      if (text === "election" || text === "2027 election") {
        const items = await getNewsByCategory("election");
        await sendNewsItems(from, items || [], "🗳️ 2027 Election updates:");
        return;
      }

      if (text === "nddc") {
        const items = await getNewsByCategory("nddc");
        await sendNewsItems(from, items || [], "📋 NDDC Tracker:");
        return;
      }

      const categoryCommands = Object.keys(CATEGORY_KEYWORDS);
      if (categoryCommands.includes(text)) {
        const items = await getNewsByCategory(text);
        await sendNewsItems(from, items || [], `📰 Latest ${text} news:`);
        return;
      }

      if (text === "saved" || text === "bookmarks") {
        const saved = bookmarks.get(from) || [];
        if (saved.length === 0) {
          await sendMessage(from, "No saved stories yet.\n\nRead some news and type 'save 1' (or save 2, save 3) to bookmark a story! 📌");
        } else {
          const msg = saved.reduce((m, s, i) => m + `${i + 1}. ${s.title}\n🔗 ${s.link}\n\n`, "📌 Your saved stories:\n\n");
          await sendMessage(from, msg.trim());
        }
        return;
      }

      const saveMatch = text.match(/^save\s*(\d*)$/);
      if (saveMatch) {
        const recent = lastSentNews.get(from);
        if (!recent || recent.length === 0) {
          await sendMessage(from, "No recent story to save. Type 'news' first to get headlines! 📰");
          return;
        }
        const idx = saveMatch[1] ? parseInt(saveMatch[1], 10) - 1 : 0;
        const story = recent[Math.min(idx, recent.length - 1)];
        if (!bookmarks.has(from)) bookmarks.set(from, []);
        const saved = bookmarks.get(from);
        if (saved.some(s => s.link === story.link)) {
          await sendMessage(from, "You already saved that one 📌 Type 'saved' to see all your bookmarks.");
        } else {
          saved.push({ title: story.title, link: story.link });
          await sendMessage(from, `📌 Saved: ${story.title}\n\nType 'saved' to see all your bookmarks.`);
        }
        return;
      }

      // ── Rate limit AI ──────────────────────────────────────────────────────
      if (!checkRateLimit(from)) {
        await sendMessage(from, "Easy now! Give me 3 seconds between questions 😄");
        return;
      }

      // ── Default: AI response ───────────────────────────────────────────────
      const aiReply = await getAIResponse(from, rawText);
      await sendMessage(from, aiReply);

    } catch (err) {
      console.error("Webhook error:", err.message);
    }
  })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NaijaScope Media Bot running on port ${PORT}`);
  startDailyDigest();
  startBreakingNewsMonitor();
});
