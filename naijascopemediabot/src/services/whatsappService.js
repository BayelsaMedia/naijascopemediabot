import axios from "axios";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";
import { sanitiseLanguage } from "../utils/language.js";

const BASE_URL = "https://graph.facebook.com/v25.0";
const getPhoneId = () => process.env.PHONE_NUMBER_ID;
const getToken  = () => process.env.WHATSAPP_TOKEN;

const MAX_MSG_LEN  = 3_500; // split threshold (WhatsApp hard limit is 4096)
const PART_DELAY   = 400;   // ms between split parts

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
      timeout: 10_000,
    }),
    { attempts: 3, baseDelayMs: 500, label: "WhatsApp API" }
  );
}

// ── Message splitting ─────────────────────────────────────────────────────────
/**
 * Split text into chunks of at most MAX_MSG_LEN characters.
 * Prefers splitting at paragraph breaks, then line breaks, then word boundaries.
 */
function chunkText(text) {
  if (text.length <= MAX_MSG_LEN) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX_MSG_LEN) {
    let cut = remaining.lastIndexOf("\n\n", MAX_MSG_LEN);
    if (cut < MAX_MSG_LEN * 0.5) cut = remaining.lastIndexOf("\n",  MAX_MSG_LEN);
    if (cut < MAX_MSG_LEN * 0.5) cut = remaining.lastIndexOf(" ",   MAX_MSG_LEN);
    if (cut < MAX_MSG_LEN * 0.5) cut = MAX_MSG_LEN;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── Typing indicator (best-effort; Cloud API support varies) ──────────────────
export async function sendTypingIndicator(to) {
  try {
    await axios.post(`${BASE_URL}/${getPhoneId()}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "typing",
    }, { headers: headers(), timeout: 3_000 });
  } catch (_) { /* silent — typing indicator is a best-effort enhancement */ }
}

// ── Core text send ────────────────────────────────────────────────────────────
export async function sendText(to, text) {
  if (!to || !text) return;
  const clean  = sanitiseLanguage(String(text));
  const chunks = chunkText(clean);

  for (let i = 0; i < chunks.length; i++) {
    let body = chunks[i];
    if (chunks.length > 1) {
      if (i < chunks.length - 1) body += `\n\n(${i + 1}/${chunks.length} — continued below)`;
      else                        body  = `(${i + 1}/${chunks.length})\n\n${body}`;
    }
    try {
      await post({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      });
    } catch (err) {
      logger.error("sendText error:", err?.response?.data || err.message);
    }
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, PART_DELAY));
  }
}

// ── Buttons ───────────────────────────────────────────────────────────────────
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
        body: { text: sanitiseLanguage(String(bodyText)).slice(0, 1024) },
        action: {
          buttons: buttons.slice(0, 3).map(b => ({
            type: "reply",
            reply: {
              id:    String(b.id).slice(0, 256),
              title: String(b.title).slice(0, 20),
            },
          })),
        },
      },
    });
  } catch (err) {
    logger.error("sendButtons error:", err?.response?.data || err.message);
    const numbered = buttons.slice(0, 3).map((b, i) => `${i + 1}. ${b.title}`).join("\n");
    await sendText(to, `${bodyText}\n\n${numbered}\n\nReply with a number to choose.`);
  }
}

// ── List ──────────────────────────────────────────────────────────────────────
/**
 * @param {string} to
 * @param {string} bodyText
 * @param {string} buttonLabel
 * @param {Array}  sections
 * @param {object} [opts]
 * @param {string} [opts.header]
 * @param {string} [opts.footer]
 */
export async function sendList(to, bodyText, buttonLabel, sections, { header, footer } = {}) {
  if (!to || !bodyText || !sections?.length) return;

  const interactive = {
    type: "list",
    body: { text: sanitiseLanguage(String(bodyText)).slice(0, 1024) },
    action: {
      button: String(buttonLabel).slice(0, 20),
      sections: sections.map(s => ({
        title: String(s.title || "").slice(0, 24),
        rows: (s.rows || []).slice(0, 10).map(r => ({
          id:          String(r.id).slice(0, 200),
          title:       String(r.title || "").slice(0, 24),
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
    let fallback = header ? `${header}\n\n` : "";
    fallback += bodyText;
    let n = 1;
    for (const s of sections) {
      fallback += `\n\n${s.title || "Options"}`;
      for (const r of (s.rows || [])) {
        fallback += `\n${n}. ${r.title}${r.description ? ` — ${r.description}` : ""}`;
        n++;
      }
    }
    if (footer) fallback += `\n\n${footer}`;
    fallback += "\n\nReply with a number to choose.";
    await sendText(to, fallback);
  }
}

// ── Read receipt ──────────────────────────────────────────────────────────────
export async function markAsRead(messageId) {
  if (!messageId) return;
  try {
    await axios.post(
      `${BASE_URL}/${getPhoneId()}/messages`,
      { messaging_product: "whatsapp", status: "read", message_id: messageId },
      { headers: headers(), timeout: 5_000 }
    );
  } catch (_) { /* silent */ }
}

// ── Media download ────────────────────────────────────────────────────────────
export async function downloadMedia(mediaId) {
  const meta = await withRetry(
    () => axios.get(`${BASE_URL}/${mediaId}`, { headers: headers(), timeout: 10_000 }),
    { attempts: 2, label: "media metadata" }
  );
  const res = await withRetry(
    () => axios.get(meta.data.url, {
      headers: headers(),
      responseType: "arraybuffer",
      timeout: 25_000,
    }),
    { attempts: 2, label: "media download" }
  );
  return { buffer: Buffer.from(res.data), mimeType: meta.data.mime_type || "audio/ogg" };
}
