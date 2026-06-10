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
  "You are the NaijaScope Media Bot, a smart, friendly and highly intelligent news and information assistant for Nigeria, specializing in the Niger Delta region, Bayelsa State, oil and gas news, Nigerian politics, and current affairs. You work for NaijaScope Media at www.bayelsamedia.com.ng. You are conversational, witty, warm and knowledgeable. Answer every question intelligently and in detail. Never say you cannot help. If asked about news, summarize what you know and direct users to the website for full stories. Use plain text only, no asterisks or markdown.";

const rssParser = new RSSParser();
const conversationHistory = new Map();

const processedMessageIds = new Set();
const MAX_PROCESSED_IDS = 1000;
const MAX_CONVERSATION_USERS = 500;

function getGroq() {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set");
  return new Groq({ apiKey: GROQ_API_KEY });
}

function trackMessageId(messageId) {
  if (processedMessageIds.has(messageId)) return false;
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > MAX_PROCESSED_IDS) {
    const firstKey = processedMessageIds.values().next().value;
    processedMessageIds.delete(firstKey);
  }
  return true;
}

function pruneConversationHistory() {
  if (conversationHistory.size > MAX_CONVERSATION_USERS) {
    const firstKey = conversationHistory.keys().next().value;
    conversationHistory.delete(firstKey);
  }
}

async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      },
      {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      }
    );
  } catch (err) {
    console.error("sendMessage error:", err?.response?.data || err.message);
  }
}

async function markAsRead(messageId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      },
      {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      }
    );
  } catch (err) {
    console.error("markAsRead error:", err?.response?.data || err.message);
  }
}

function sanitizeXml(raw) {
  return raw
    .replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFE\uFFFF]/g, "");
}

async function fetchNews() {
  try {
    const response = await axios.get("https://www.bayelsamedia.com.ng/feed", {
      responseType: "text",
      timeout: 10000,
    });
    const xml = sanitizeXml(response.data);
    const feed = await rssParser.parseString(xml);
    const items = feed.items.slice(0, 5);
    let msg = "📰 Latest from NaijaScope Media:\n\n";
    items.forEach((item, i) => {
      msg += `${i + 1}. ${item.title}\n🔗 ${item.link}\n\n`;
    });
    msg += "Visit www.bayelsamedia.com.ng for full stories 🇳🇬";
    return msg;
  } catch (err) {
    console.error("fetchNews error:", err.message);
    return "Visit www.bayelsamedia.com.ng for the latest news! 📰";
  }
}

async function getAIResponse(userId, userMessage) {
  try {
    const groq = getGroq();

    if (!conversationHistory.has(userId)) {
      conversationHistory.set(userId, []);
      pruneConversationHistory();
    }
    const history = conversationHistory.get(userId);

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: userMessage },
    ];

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
    });

    const response = completion.choices[0].message.content;

    history.push({ role: "user", content: userMessage });
    history.push({ role: "assistant", content: response });

    if (history.length > 10) {
      history.splice(0, history.length - 10);
    }

    return response;
  } catch (err) {
    console.error("getAIResponse error:", err.message);
    return "I am having a small issue right now. Please try again shortly!";
  }
}

const WELCOME_MENU = `👋 Welcome to NaijaScope Media Bot!

Your smart news and information assistant.

What I can do:

📰 NEWS - Type 'news' for latest NaijaScope articles
🤖 ASK ME - Type any question for AI answers
📞 CONTACT - Type 'contact' for our info
ℹ️ HELP - Type 'help' to see this menu

Powered by NaijaScope Media 🇳🇬
www.bayelsamedia.com.ng`;

const CONTACT_INFO = `📞 NaijaScope Media Contact:

🌐 Website: www.bayelsamedia.com.ng
📧 Email: admin@bayelsamedia.com.ng

We'd love to hear from you! 🇳🇬`;

app.get("/", (req, res) => {
  res.status(200).send("NaijaScope Media Bot is running");
});

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

      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;

      if (!messages || messages.length === 0) return;

      const message = messages[0];
      const from = message.from;
      const messageId = message.id;

      if (!from || !messageId) return;

      if (!trackMessageId(messageId)) {
        console.log(`Duplicate message skipped: ${messageId}`);
        return;
      }

      await markAsRead(messageId);

      if (message.type === "image") {
        await sendMessage(from, "📷 I received your image! Please describe what you need help with and I will assist you.");
        return;
      }

      if (message.type === "audio") {
        await sendMessage(from, "🎤 I received your voice note! Please type your message and I will be happy to help.");
        return;
      }

      if (message.type !== "text" || !message.text?.body) return;

      const text = message.text.body.trim().toLowerCase();

      if (text === "news") {
        const news = await fetchNews();
        await sendMessage(from, news);
      } else if (text === "contact") {
        await sendMessage(from, CONTACT_INFO);
      } else if (text === "help") {
        await sendMessage(from, WELCOME_MENU);
      } else {
        const aiReply = await getAIResponse(from, message.text.body.trim());
        await sendMessage(from, aiReply);
      }
    } catch (err) {
      console.error("Webhook processing error:", err.message);
    }
  })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NaijaScope Media Bot is running on port ${PORT}`);
});
