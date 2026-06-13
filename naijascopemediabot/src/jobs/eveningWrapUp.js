import cron from "node-cron";
import { query } from "../utils/db.js";
import { sendText } from "../services/whatsappService.js";
import { generateEveningWrap } from "../services/aiService.js";
import { logger } from "../utils/logger.js";

const sentToday = new Set();

export async function sendEveningWrapUp(fetchRSSItems) {
  const today = new Date().toLocaleDateString("en-GB", {
    timeZone: "Africa/Lagos",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  try {
    const res = await query(
      `SELECT u.whatsapp_number
       FROM users u
       JOIN user_subscriptions s ON u.whatsapp_number = s.whatsapp_number
       WHERE s.subscription_type = 'daily_digest'`
    );
    const subscribers = res.rows;
    if (subscribers.length === 0) return;

    const items     = await fetchRSSItems(true);
    const top5      = items.slice(0, 5);
    const headlines = top5.map(i => i.title);
    const wrap      = await generateEveningWrap(headlines);
    if (!wrap) return;

    const header = `NaijaScope Media — Evening Intelligence Wrap\n${today}\n\n`;
    const links  = top5.map((item, i) => `${i + 1}. ${item.title}\n${item.link}`).join("\n\n");
    const footer = "\n\nwww.bayelsamedia.com.ng";

    logger.info(`[EVENING WRAP] Sending to ${subscribers.length} subscribers`);

    for (const { whatsapp_number } of subscribers) {
      const key = `${whatsapp_number}_evening_${today}`;
      if (sentToday.has(key)) continue;
      try {
        await sendText(whatsapp_number, header + wrap);
        await sendText(whatsapp_number, `Today's Top Stories:\n\n${links}${footer}`);
        sentToday.add(key);
        await new Promise(r => setTimeout(r, 1_200));
      } catch (err) {
        logger.error(`[EVENING WRAP] Failed for ${whatsapp_number}:`, err.message);
      }
    }

    if (sentToday.size > 5_000) sentToday.clear();
  } catch (err) {
    logger.error("[EVENING WRAP] job error:", err.message);
  }
}

export function startEveningWrapUpJob(fetchRSSItems) {
  cron.schedule("0 19 * * *", async () => {
    logger.info("[CRON] Running evening wrap-up job");
    await sendEveningWrapUp(fetchRSSItems);
  }, { timezone: "Africa/Lagos" });
  logger.info("[CRON] Evening Wrap-Up scheduled for 19:00 WAT");
}
