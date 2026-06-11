import cron from "node-cron";
import { query } from "../utils/db.js";
import { sendText } from "../services/whatsappService.js";
import { sendMainMenu } from "../whatsapp/menus.js";
import { applyUserLanguage } from "../services/languageService.js";
import { logger } from "../utils/logger.js";

const sentToday = new Set();

export async function sendDailyBriefings(fetchRSSItems) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const res = await query(
      `SELECT u.whatsapp_number, u.language_pref
       FROM users u
       JOIN user_subscriptions s ON u.whatsapp_number = s.whatsapp_number
       WHERE s.subscription_type = 'daily_digest'`
    );
    const subscribers = res.rows;
    if (subscribers.length === 0) return;

    logger.info(`[DIGEST] Sending to ${subscribers.length} subscribers`);
    const items = await fetchRSSItems(true);
    const top5  = items.slice(0, 5);

    for (const user of subscribers) {
      const key = `${user.whatsapp_number}_${today}`;
      if (sentToday.has(key)) continue;
      try {
        const headlines = top5.map((item, i) => `${i + 1}. ${item.title}`).join("\n");
        let msg = `🌅 Good morning! Your NaijaScope daily briefing 📰\n\n${headlines}\n\nwww.bayelsamedia.com.ng`;
        if (user.language_pref && user.language_pref !== "en") {
          msg = await applyUserLanguage(msg, user);
        }
        await sendText(user.whatsapp_number, msg);
        await sendMainMenu(user.whatsapp_number);
        sentToday.add(key);
        await new Promise(r => setTimeout(r, 1_200));
      } catch (err) {
        logger.error(`[DIGEST] Failed for ${user.whatsapp_number}:`, err.message);
      }
    }

    if (sentToday.size > 5_000) sentToday.clear();
  } catch (err) {
    logger.error("[DIGEST] error:", err.message);
  }
}

export function startDailyBriefingJob(fetchRSSItems) {
  cron.schedule("0 6 * * *", async () => {
    logger.info("[CRON] Running daily briefing job");
    await sendDailyBriefings(fetchRSSItems);
  }, { timezone: "Africa/Lagos" });
  logger.info("[CRON] Daily briefing scheduled for 07:00 WAT");
}
