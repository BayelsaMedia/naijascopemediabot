import { query } from "../utils/db.js";
import { sendText } from "./whatsappService.js";
import { addUserAlert } from "../state/sessionState.js";
import { logger } from "../utils/logger.js";
import { SITE_URL } from "../config/constants.js";

export async function getSubscribers(type) {
  const res = await query(
    "SELECT whatsapp_number FROM user_subscriptions WHERE subscription_type = $1",
    [type]
  );
  return res.rows.map(r => r.whatsapp_number);
}

export async function addSubscription(whatsappNumber, type, value = type) {
  await query(
    `INSERT INTO user_subscriptions (whatsapp_number, subscription_type, subscription_value)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [whatsappNumber, type, value]
  );
  await query(
    "UPDATE users SET subscription_status = true WHERE whatsapp_number = $1",
    [whatsappNumber]
  );
}

export async function removeSubscription(whatsappNumber, type) {
  await query(
    "DELETE FROM user_subscriptions WHERE whatsapp_number = $1 AND subscription_type = $2",
    [whatsappNumber, type]
  );
}

// ── Keyword alerts ─────────────────────────────────────────────────────────────
export async function persistKeywordAlert(whatsappNumber, keyword) {
  await query(
    `INSERT INTO user_keyword_alerts (whatsapp_number, keyword)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [whatsappNumber, keyword.toLowerCase()]
  );
  addUserAlert(whatsappNumber, keyword);
}

export async function getAllKeywordAlerts() {
  const res = await query("SELECT whatsapp_number, keyword FROM user_keyword_alerts");
  return res.rows;
}

// ── Breaking alert broadcast ───────────────────────────────────────────────────
export async function sendBreakingAlert(item, subscribers) {
  const msg = `🔴 BREAKING: ${item.title}\n🔗 ${item.link}\n\nNaijaScope Media | ${SITE_URL}`;
  let sent = 0;
  for (const number of subscribers) {
    try {
      await sendText(number, msg);
      await new Promise(r => setTimeout(r, 600));
      sent++;
    } catch (err) {
      logger.error(`sendBreakingAlert failed for ${number}:`, err.message);
    }
  }
  logger.info(`[BREAKING] Sent to ${sent}/${subscribers.length} subscribers`);
}
