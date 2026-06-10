import axios from "axios";
import { logger } from "../utils/logger.js";

const BASE_URL = `https://graph.facebook.com/v25.0`;
const getPhoneId = () => process.env.PHONE_NUMBER_ID;
const getToken = () => process.env.WHATSAPP_TOKEN;

function headers() {
  return {
    Authorization: `Bearer ${getToken()}`,
    "Content-Type": "application/json",
  };
}

export async function sendText(to, text) {
  try {
    await axios.post(
      `${BASE_URL}/${getPhoneId()}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: headers() }
    );
  } catch (err) {
    logger.error("sendText error:", err?.response?.data || err.message);
  }
}

export async function sendButtons(to, bodyText, buttons) {
  try {
    await axios.post(
      `${BASE_URL}/${getPhoneId()}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: buttons.slice(0, 3).map((b) => ({
              type: "reply",
              reply: { id: b.id, title: b.title.slice(0, 20) },
            })),
          },
        },
      },
      { headers: headers() }
    );
  } catch (err) {
    logger.error("sendButtons error:", err?.response?.data || err.message);
    await sendText(to, bodyText + "\n\nType: news, help, subscribe, or ask me anything!");
  }
}

export async function sendList(to, bodyText, buttonLabel, sections) {
  try {
    await axios.post(
      `${BASE_URL}/${getPhoneId()}/messages`,
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
      { headers: headers() }
    );
  } catch (err) {
    logger.error("sendList error:", err?.response?.data || err.message);
    await sendText(to, bodyText);
  }
}

export async function markAsRead(messageId) {
  try {
    await axios.post(
      `${BASE_URL}/${getPhoneId()}/messages`,
      { messaging_product: "whatsapp", status: "read", message_id: messageId },
      { headers: headers() }
    );
  } catch (_) {}
}

export async function downloadMedia(mediaId) {
  const meta = await axios.get(`${BASE_URL}/${mediaId}`, { headers: headers() });
  const res = await axios.get(meta.data.url, {
    headers: headers(),
    responseType: "arraybuffer",
    timeout: 20000,
  });
  return { buffer: Buffer.from(res.data), mimeType: meta.data.mime_type || "audio/ogg" };
}
