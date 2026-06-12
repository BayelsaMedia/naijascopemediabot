import axios from "axios";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";

const BASE_URL = "https://graph.facebook.com/v25.0";
const getPhoneId = () => process.env.PHONE_NUMBER_ID;
const getToken = () => process.env.WHATSAPP_TOKEN;

function headers() {
  return {
    Authorization: `Bearer ${getToken()}`,
    "Content-Type": "application/json",
  };
}

async function post(payload) {
  return withRetry(
    () => axios.post(`${BASE_URL}/${getPhoneId()}/messages`, payload, {
      headers: headers(),
      timeout: 10000,
    }),
    { attempts: 3, baseDelayMs: 500, label: "WhatsApp API" }
  );
}

export async function sendText(to, text) {
  if (!to || !text) return;
  try {
    await post({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: String(text).slice(0, 4096) },
    });
  } catch (err) {
    logger.error("sendText error:", err?.response?.data || err.message);
  }
}

export async function sendButtons(to, bodyText, buttons) {
  if (!to || !bodyText || !buttons?.length) return;
  try {
    await post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: String(bodyText).slice(0, 1024) },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: "reply",
            reply: {
              id: String(b.id).slice(0, 256),
              title: String(b.title).slice(0, 20),
            },
          })),
        },
      },
    });
  } catch (err) {
    logger.error("sendButtons error:", err?.response?.data || err.message);
    // 3d. Plain-text fallback with numbered options
    const numbered = buttons.slice(0, 3).map((b, i) => `${i + 1}. ${b.title}`).join("\n");
    await sendText(to, `${bodyText}\n\n${numbered}\n\nReply with a number to choose.`);
  }
}

/**
 * Send a WhatsApp interactive list message.
 * @param {string} to
 * @param {string} bodyText
 * @param {string} buttonLabel
 * @param {Array}  sections
 * @param {object} [opts]            — optional header / footer
 * @param {string} [opts.header]     — plain-text header (max 60 chars)
 * @param {string} [opts.footer]     — plain-text footer (max 60 chars)
 */
export async function sendList(to, bodyText, buttonLabel, sections, { header, footer } = {}) {
  if (!to || !bodyText || !sections?.length) return;

  const interactive = {
    type: "list",
    body: { text: String(bodyText).slice(0, 1024) },
    action: {
      button: String(buttonLabel).slice(0, 20),
      sections: sections.map(s => ({
        title: String(s.title || "").slice(0, 24),
        rows: (s.rows || []).slice(0, 10).map(r => ({
          id: String(r.id).slice(0, 200),
          title: String(r.title || "").slice(0, 24),
          description: String(r.description || "").slice(0, 72),
        })),
      })),
    },
  };

  if (header) interactive.header = { type: "text", text: String(header).slice(0, 60) };
  if (footer) interactive.footer = { text: String(footer).slice(0, 60) };

  try {
    await post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive,
    });
  } catch (err) {
    logger.error("sendList error:", err?.response?.data || err.message);
    // 3d. Plain-text fallback with numbered options
    let fallback = header ? `*${header}*\n\n` : "";
    fallback += bodyText;
    let counter = 1;
    for (const s of sections) {
      fallback += `\n\n*${s.title || "Options"}*`;
      for (const r of (s.rows || [])) {
        fallback += `\n${counter}. ${r.title}${r.description ? ` — ${r.description}` : ""}`;
        counter++;
      }
    }
    if (footer) fallback += `\n\n_${footer}_`;
    fallback += "\n\nReply with a number to choose.";
    await sendText(to, fallback);
  }
}

export async function markAsRead(messageId) {
  if (!messageId) return;
  try {
    await axios.post(
      `${BASE_URL}/${getPhoneId()}/messages`,
      { messaging_product: "whatsapp", status: "read", message_id: messageId },
      { headers: headers(), timeout: 5000 }
    );
  } catch (_) { /* silent — not worth surfacing */ }
}

export async function downloadMedia(mediaId) {
  const meta = await withRetry(
    () => axios.get(`${BASE_URL}/${mediaId}`, { headers: headers(), timeout: 10000 }),
    { attempts: 2, label: "media metadata" }
  );
  const res = await withRetry(
    () => axios.get(meta.data.url, {
      headers: headers(),
      responseType: "arraybuffer",
      timeout: 25000,
    }),
    { attempts: 2, label: "media download" }
  );
  return { buffer: Buffer.from(res.data), mimeType: meta.data.mime_type || "audio/ogg" };
}
