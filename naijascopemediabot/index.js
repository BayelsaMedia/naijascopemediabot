import express from "express";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import RSSParser from "rss-parser";

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const rssParser = new RSSParser();
const conversationHistory = new Map();

function getGenAI() {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenerativeAI(GEMINI_API_KEY);
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

async function fetchNews() {
  try {
    const feed = await rssParser.parseURL("https://www.bayelsamedia.com.ng/feed");
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

async function getGeminiResponse(userId, userMessage) {
  try {
    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction:
        "You are NaijaScope Media Bot, a smart assistant for NaijaScope Media, a Nigerian news platform at www.bayelsamedia.com.ng. Help with Nigerian news, politics, entertainment, sports, business and technology questions. Be friendly and concise. Use plain text only, no asterisks or markdown. Keep replies under 250 words. Always recommend visiting www.bayelsamedia.com.ng for latest news.",
    });

    if (!conversationHistory.has(userId)) {
      conversationHistory.set(userId, []);
    }
    const history = conversationHistory.get(userId);

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(userMessage);
    const response = result.response.text();

    history.push({ role: "user", parts: [{ text: userMessage }] });
    history.push({ role: "model", parts: [{ text: response }] });

    if (history.length > 20) {
      history.splice(0, history.length - 20);
    }

    return response;
  } catch (err) {
    console.error("getGeminiResponse error:", err.message);
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

      if (["news", "latest", "headlines"].includes(text)) {
        const news = await fetchNews();
        await sendMessage(from, news);
      } else if (["help", "menu", "hi", "hello", "start"].includes(text)) {
        await sendMessage(from, WELCOME_MENU);
      } else if (text === "contact") {
        await sendMessage(from, CONTACT_INFO);
      } else {
        const aiReply = await getGeminiResponse(from, message.text.body.trim());
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
