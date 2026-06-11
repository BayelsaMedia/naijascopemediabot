import axios from "axios";
import RSSParser from "rss-parser";
import { logger } from "../utils/logger.js";
import { CircuitBreaker } from "../utils/retry.js";
import { sendText, sendList } from "./whatsappService.js";
import { sendAfterNewsMenu } from "../whatsapp/menus.js";
import { lastSentNews, userAlerts } from "../state/sessionState.js";
import { CATEGORY_KEYWORDS, BAYELSA_LGAS, RSS_FEED_URL, SITE_URL, CACHE_TTL_MS } from "../config/constants.js";
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
const rssCircuit = new CircuitBreaker({ name: "RSS Feed",        threshold: 4, resetMs: 120_000 });
const oilCircuit = new CircuitBreaker({ name: "Oil Price API",   threshold: 3, resetMs:  60_000 });
const fxCircuit  = new CircuitBreaker({ name: "Exchange Rate API", threshold: 3, resetMs: 60_000 });

// ── XML sanitizer ─────────────────────────────────────────────────────────────
function sanitizeXml(raw) {
  return raw
    .replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFE\uFFFF]/g, "");
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
    const kws = CATEGORY_KEYWORDS[category] || [category];
    const filtered = items.filter(item =>
      kws.some(kw => (item.title || "").toLowerCase().includes(kw.toLowerCase()))
    );
    const result = (filtered.length > 0 ? filtered : items).slice(0, 5);
    setCache(`cat_${category}`, result);
    return result;
  } catch (err) {
    logger.error("getNewsByCategory error:", err.message);
    return null;
  }
}

// ── Send news to user ─────────────────────────────────────────────────────────
export async function sendNewsItems(to, items, header, userRow) {
  if (!items || items.length === 0) {
    await sendText(to, `No stories found right now. Stay tuned or visit ${SITE_URL} 🔗`);
    return;
  }

  lastSentNews.set(to, items);
  const top = items.slice(0, 5);

  const rows = top.map((item, i) => ({
    id:          `story_${i}`,
    title:       (item.title || "Story").slice(0, 24),
    description: "Read more →",
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
    const fallback = top.reduce(
      (m, item, i) => m + `${i + 1}. ${item.title}\n🔗 ${item.link}\n\n`,
      bodyText + "\n\n"
    ) + `${SITE_URL} 🇳🇬`;
    await sendText(to, fallback);
  }

  await sendAfterNewsMenu(to);
}

// ── Keyword alert checker (called by breaking news monitor) ───────────────────
export async function checkKeywordAlerts(newItems) {
  if (newItems.length === 0 || userAlerts.size === 0) return;
  for (const [userId, keywords] of userAlerts) {
    for (const item of newItems) {
      const title = (item.title || "").toLowerCase();
      for (const kw of keywords) {
        if (title.includes(kw.toLowerCase())) {
          await sendText(userId, `🔔 Alert — "${kw}"\n\n${item.title}\n🔗 ${item.link}`);
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
      const res = await axios.get(
        "https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=2d",
        { timeout: 8_000, headers: { "User-Agent": "Mozilla/5.0" } }
      );
      const meta  = res.data.chart.result[0].meta;
      const price = (meta.regularMarketPrice || 0).toFixed(2);
      const prev  = (meta.chartPreviousClose || meta.regularMarketPrice || 0).toFixed(2);
      const diff  = (price - prev).toFixed(2);
      const arrow = diff >= 0 ? "📈" : "📉";
      const msg   = `🛢️ Brent Crude: $${price}/barrel ${arrow}\nChange today: ${diff >= 0 ? "+" : ""}${diff}\n\nNiger Delta is watching. Want oil sector news?`;
      setCache("oil_price", msg);
      return msg;
    },
    () => getCache("oil_price") || "Market data is taking a nap right now 😅\nType 'oil' for oil sector news."
  );
}

// ── Exchange rate ─────────────────────────────────────────────────────────────
export async function fetchExchangeRate() {
  const cached = getCache("exchange_rate");
  if (cached) return cached;
  return fxCircuit.call(
    async () => {
      const res = await axios.get("https://api.exchangerate-api.com/v4/latest/USD", { timeout: 8_000 });
      const ngn  = res.data.rates?.NGN;
      if (!ngn) throw new Error("NGN rate not found");
      const parallel = Math.round(ngn * 1.08);
      const msg = `💵 USD/NGN Exchange Rate:\n\n🏦 Market Rate: $1 = ₦${Math.round(ngn)}\n💸 Parallel (est.): $1 = ₦${parallel}\n\nRates fluctuate — visit CBN.gov.ng for the official rate. Anything else? 👇`;
      setCache("exchange_rate", msg);
      return msg;
    },
    () => getCache("exchange_rate") || "Couldn't fetch the exchange rate right now 😅\nCheck cbn.gov.ng for the official rate."
  );
}

// ── Weather ───────────────────────────────────────────────────────────────────
export async function fetchWeather(city) {
  try {
    const cached = getCache(`weather_${city.toLowerCase()}`);
    if (cached) return cached;
    const res = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { timeout: 8_000 });
    const cur = res.data.current_condition[0];
    const msg = `🌤️ ${city} weather:\n${cur.weatherDesc[0].value}, ${cur.temp_C}°C (feels like ${cur.FeelsLikeC}°C)\nHumidity: ${cur.humidity}%\n\nStay safe! Anything else?`;
    setCache(`weather_${city.toLowerCase()}`, msg);
    return msg;
  } catch {
    return `Couldn't get weather for ${city} right now 🌧️\nTry again shortly or check a weather app.`;
  }
}

// ── Flood alert ───────────────────────────────────────────────────────────────
export async function fetchFloodAlert() {
  try {
    const cached = getCache("flood_alert");
    if (cached) return cached;
    const res  = await axios.get("https://wttr.in/Yenagoa?format=j1", { timeout: 8_000 });
    const cur  = res.data.current_condition[0];
    const rain = res.data.weather?.[0]?.hourly?.reduce((sum, h) => sum + parseFloat(h.precipMM || 0), 0) || 0;
    const humidity = parseInt(cur.humidity || 0);
    let risk = "LOW"; let emoji = "🟢";
    if (rain > 20 || humidity > 90) { risk = "HIGH";     emoji = "🔴"; }
    else if (rain > 8 || humidity > 80) { risk = "MODERATE"; emoji = "🟡"; }
    const lgaLines = BAYELSA_LGAS.slice(0, 5).map(lga => `• ${lga}: ${risk}`).join("\n");
    const msg = `${emoji} Bayelsa Flood Risk: ${risk}\n\n${lgaLines}\n\nRainfall: ${rain.toFixed(1)}mm | Humidity: ${humidity}%\n\nStay safe. Follow official BYSEMA alerts.`;
    setCache("flood_alert", msg);
    return msg;
  } catch {
    return "Couldn't fetch flood data right now 🌊\nMonitor BYSEMA and local authorities for updates.";
  }
}
