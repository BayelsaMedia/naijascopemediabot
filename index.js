const express = require("express");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const RSSParser = require("rss-parser");

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const parser = new RSSParser();
const conversations = new Map();

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;
    const from = message.from;
    if (message.type === "text") {
      const text = message.text.body.toLowerCase();
      await markAsRead(message.id);
      let reply;
      if (text.includes("news") || text.includes("latest") || text.includes("headlines")) {
        reply = await fetchNews();
      } else if (text.includes("contact")) {
        reply = "📞 NaijaScope Media Contact:\n\n🌐 Website: www.bayelsamedia.com.ng\n📧 Email: admin@bayelsamedia.com.ng\n\nWe'd love to hear from you! 🇳🇬";
      } else if (text.includes("help") || text.includes("menu") || text.includes("hi") || text.includes("hello") || text.includes("start")) {
        reply = "👋 Welcome to NaijaScope Media Bot!\n\nYour smart news and information assistant.\n\nWhat I can do:\n\n📰 NEWS - Type 'news' for latest articles\n🤖 ASK ME - Type any question for AI answers\n📞 CONTACT - Type 'contact' for our info\nℹ️ HELP - Type 'help' to see this menu\n\nPowered by NaijaScope Media 🇳🇬\nwww.bayelsamedia.com.ng";
      } else {
        reply = await getGeminiResponse(from, message.text.body);
      }
      await sendMessage(from, reply);
    } else if (message.type === "image") {
      await sendMessage(from, "📷 I received your image! Please describe what you need help with and I will assist you.");
    } else if (message.type === "audio") {
      await sendMessage(from, "🎤 I received your voice note! Please type your message and I will be happy to help.");
    }
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

async function fetchNews() {
  try {
    const feed = await parser.parseURL("https://www.bayelsamedia.com.ng/feed");
    const items = feed.items.slice(0, 5);
    let msg = "📰 Latest from NaijaScope Media:\n\n";
    items.forEach((item, i) => {
      msg += `${i + 1}. ${item.title}\n🔗 ${item.link}\n\n`;
    });
    msg += "Visit www.bayelsamedia.com.ng for full stories 🇳🇬";
    return msg;
  } catch (err) {
    console.error("RSS error:", err.message);
    return "Visit www.bayelsamedia.com.ng for the latest news! 📰";
  }
}

async function getGeminiResponse(userId, userMessage) {
  try {
    if (!conversations.has(userId)) conversations.set(userId, []);
    const history = conversations.get(userId);
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: "You are NaijaScope Media Bot, a smart assistant for NaijaScope Media, a Nigerian news platform at www.bayelsamedia.com.ng. Help with Nigerian news, politics, entertainment, sports, business and technology. Be friendly and concise. Use plain text only, no asterisks or markdown. Keep replies under 250 words.",
    });
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(userMessage);
    const reply = result.response.text();
    history.push({ role: "user", parts: [{ text: userMessage }] });
    history.push({ role: "model", parts: [{ text: reply }] });
    if (history.length > 20) history.splice(0, 2);
    return reply;
  } catch (err) {
    console.error("Gemini error:", err.message);
    return "I am having a small issue right now. Please try again shortly!";
  }
}

async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Send error:", err.response?.data || err.message);
  }
}

async function markAsRead(messageId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", status: "read", message_id: messageId },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) {}
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NaijaScope Media Bot is running on port ${PORT}`));
