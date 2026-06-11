import axios from "axios";
import RSSParser from "rss-parser";
import { logger } from "../utils/logger.js";
import { CircuitBreaker } from "../utils/retry.js";
import { sendText, sendButtons } from "./whatsappService.js";
import { sendAfterNewsMenu } from "../whatsapp/menus.js";
import { lastSentNews, userAlerts } from "../state/sessionState.js";
import { CATEGORY_KEYWORDS, CATEGORY_META, BAYELSA_LGAS, RSS_FEED_URL, SITE_URL, CACHE_TTL_MS } from "../config/constants.js";
import { translateArticle } from "./languageService.js";

const rssParser = new RSSParser();

// ── In-memory cache ───────────────────────────────────────────────────────────
const newsCache = new Map();
function getCache(key) {
  const entry = newsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) { newsCache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) { newsCache.set(key, { data, timestamp: Date.now() }); }

// ── Circuit breakers ──────────────────────────────────────────────────────────
const rssCircuit = new CircuitBreaker({ name: "RSS Feed",          threshold: 4, resetMs: 120_000 });
const oilCircuit = new CircuitBreaker({ name: "Oil Price API",     threshold: 3, resetMs:  60_000 });
const fxCircuit  = new CircuitBreaker({ name: "Exchange Rate API", threshold: 3, resetMs:  60_000 });

// ── XML sanitizer ─────────────────────────────────────────────────────────────
function sanitizeXml(raw) {
  return raw
    .replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFE\uFFFF]/g, "");
}

// ── Category detector ─────────────────────────────────────────────────────────
export function categorizeStory(item) {
  const title = (item.title || "").toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some(kw => title.includes(kw.toLowerCase()))) {
      return CATEGORY_META[cat] || { label: "News", emoji: "📰" };
    }
  }
  return { label: "News", emoji: "📰" };
}

// ── Relative time formatter ───────────────────────────────────────────────────
function timeAgo(isoDate) {
  if (!isoDate) return "";
  const diff = Math.round((Date.now() - new Date(isoDate).getTime()) / 60_000);
  if (diff < 1)   return "just now";
  if (diff < 60)  return `${diff}m ago`;
  const h = Math.floor(diff / 60);
  if (h < 24)     return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Context-aware editorial header ───────────────────────────────────────────
function editorialHeader(header) {
  if (header) return header;
  const hour = new Date().toLocaleString("en-NG", { timeZone: "Africa/Lagos", hour: "numeric", hour12: false });
  const h = parseInt(hour);
  if (h < 12) return "☀️ This morning in Nigeria:";
  if (h < 17) return "🌤️ The afternoon headlines:";
  return "🌆 Tonight's top stories:";
}

// ── RSS feed ──────────────────────────────────────────────────────────────────
export async function fetchRSSItems(bypassCache = false) {
  if (!bypassCache) {
    const cached = getCache("rss_all");
    if (cached) return cached;
  }
  return rssCircuit.call(
    async () => {
      const response = await axios.get(RSS_FEED_URL, { responseType: "text", timeout: 10_000 });
      const xml  = sanitizeXml(response.data);
      const feed = await rssParser.parseString(xml);
      setCache("rss_all", feed.items);
      return feed.items;
    },
    () => getCache("rss_all") || []
  );
}

export async function getNewsByCategory(category) {
  try {
    const cached = getCache(`cat_${category}`);
    if (cached) return cached;
    const items = await fetchRSSItems();
    const kws   = CATEGORY_KEYWORDS[category] || [category];
    const filtered = items.filter(item =>
      kws.some(kw => (item.title || "").toLowerCase().includes(kw.toLowerCase()))
    );
    const result = (filtered.length > 0 ? filtered : items).slice(0, 5);
    setCache(`cat_${category}`, result);
    return result;
  } catch (err) {
    logger.error("getNewsByCategory error:", err.message);
    return [];
  }
}

// ── Premium story card renderer ───────────────────────────────────────────────
function buildStoryCard(items, headerText) {
  const divider = "─────────────────";
  const lines   = items.slice(0, 5).map((item, i) => {
    const { emoji } = categorizeStory(item);
    const when      = timeAgo(item.isoDate);
    const tag       = when ? ` · ${when}` : "";
    return `${i + 1}. ${emoji} ${item.title}\n🔗 ${item.link}${tag}`;
  });
  return [headerText, divider, ...lines, divider, SITE_URL].join("\n\n");
}

// ── Send news to user ─────────────────────────────────────────────────────────
export async function sendNewsItems(to, items, header, userRow) {
  if (!items || items.length === 0) {
    await sendText(to, `Nothing breaking at this moment — check ${SITE_URL} for the latest. I'll alert you the moment something hits. 🔔`);
    await sendButtons(to, "What would you like to do?", [
      { id: "menu_subscribe", title: "📡 Set Alerts" },
      { id: "main_menu",      title: "🏠 Main Menu"  },
    ]);
    return;
  }

  lastSentNews.set(to, items);
  const top        = items.slice(0, 5);
  const hdr        = editorialHeader(header);
  let   storyCard  = buildStoryCard(top, hdr);

  if (userRow?.language_pref && userRow.language_pref !== "en") {
    try {
      storyCard = await translateArticle(storyCard, userRow.language_pref);
    } catch (_) {}
  }

  await sendText(to, storyCard);
  await sendAfterNewsMenu(to);
}

// ── Keyword alert checker ─────────────────────────────────────────────────────
export async function checkKeywordAlerts(newItems) {
  if (newItems.length === 0 || userAlerts.size === 0) return;
  for (const [userId, keywords] of userAlerts) {
    for (const item of newItems) {
      const title = (item.title || "").toLowerCase();
      for (const kw of keywords) {
        if (title.includes(kw.toLowerCase())) {
          const { emoji } = categorizeStory(item);
          await sendText(
            userId,
            `🔔 Story Alert — "${kw}"\n\n${emoji} ${item.title}\n\nThis story matches your alert.\n🔗 ${item.link}\n\nReply "why" for AI context, or "save" to bookmark it.`
          );
          await new Promise(r => setTimeout(r, 400));
          break;
        }
      }
    }
  }
}

// ── Oil price ─────────────────────────────────────────────────────────────────
export async function fetchOilPrice() {
  const cached = getCache("oil_price");
  if (cached) return cached;
  return oilCircuit.call(
    async () => {
      const res   = await axios.get(
        "https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=2d",
        { timeout: 8_000, headers: { "User-Agent": "Mozilla/5.0" } }
      );
      const meta  = res.data.chart.result[0].meta;
      const price = (meta.regularMarketPrice || 0).toFixed(2);
      const prev  = (meta.chartPreviousClose || meta.regularMarketPrice || 0).toFixed(2);
      const diff  = (price - prev).toFixed(2);
      const dir   = diff >= 0 ? "up" : "down";
      const arrow = diff >= 0 ? "📈" : "📉";
      const msg   = `🛢️ Brent Crude\n\n$${price} per barrel ${arrow}\n${dir === "up" ? "+" : ""}${diff} today\n\nNiger Delta is watching. Type "oil" for sector news.`;
      setCache("oil_price", msg);
      return msg;
    },
    () => getCache("oil_price") || "Market data is temporarily unavailable.\nType 'oil' for oil sector news instead. 🛢️"
  );
}

// ── Exchange rate ─────────────────────────────────────────────────────────────
export async function fetchExchangeRate() {
  const cached = getCache("exchange_rate");
  if (cached) return cached;
  return fxCircuit.call(
    async () => {
      const res     = await axios.get("https://api.exchangerate-api.com/v4/latest/USD", { timeout: 8_000 });
      const ngn     = res.data.rates?.NGN;
      if (!ngn) throw new Error("NGN rate not found");
      const parallel = Math.round(ngn * 1.08);
      const msg = `💵 USD / NGN\n\n🏦 Official: $1 = ₦${Math.round(ngn)}\n💸 Parallel (est.): $1 = ₦${parallel}\n\nFor the official CBN rate → cbn.gov.ng`;
      setCache("exchange_rate", msg);
      return msg;
    },
    () => getCache("exchange_rate") || "Exchange rate data is temporarily unavailable.\nCheck cbn.gov.ng for the official rate. 💵"
  );
}

// ── Weather ───────────────────────────────────────────────────────────────────
export async function fetchWeather(city) {
  try {
    const cached = getCache(`weather_${city.toLowerCase()}`);
    if (cached) return cached;
    const res = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { timeout: 8_000 });
    const cur = res.data.current_condition[0];
    const msg = `🌤️ ${city}\n\n${cur.weatherDesc[0].value}\n${cur.temp_C}°C · Feels like ${cur.FeelsLikeC}°C\nHumidity: ${cur.humidity}%\n\nStay prepared out there. Anything else?`;
    setCache(`weather_${city.toLowerCase()}`, msg);
    return msg;
  } catch {
    return `Couldn't pull weather data for ${city} right now.\nTry again in a moment, or check a weather app. 🌤️`;
  }
}

// ── Flood alert ───────────────────────────────────────────────────────────────
export async function fetchFloodAlert() {
  try {
    const cached = getCache("flood_alert");
    if (cached) return cached;
    const res      = await axios.get("https://wttr.in/Yenagoa?format=j1", { timeout: 8_000 });
    const cur      = res.data.current_condition[0];
    const rain     = res.data.weather?.[0]?.hourly?.reduce((s, h) => s + parseFloat(h.precipMM || 0), 0) || 0;
    const humidity = parseInt(cur.humidity || 0);
    let risk = "LOW"; let emoji = "🟢";
    if (rain > 20 || humidity > 90)       { risk = "HIGH";     emoji = "🔴"; }
    else if (rain > 8 || humidity > 80)   { risk = "MODERATE"; emoji = "🟡"; }
    const lgaLines = BAYELSA_LGAS.slice(0, 5).map(lga => `· ${lga}: ${risk}`).join("\n");
    const msg = `${emoji} Bayelsa Flood Risk: ${risk}\n\n${lgaLines}\n\nRainfall: ${rain.toFixed(1)}mm · Humidity: ${humidity}%\n\nFollow BYSEMA for official updates. Stay safe.`;
    setCache("flood_alert", msg);
    return msg;
  } catch {
    return "Flood data is temporarily unavailable.\nMonitor BYSEMA and local authorities directly. 🌊";
  }
}
