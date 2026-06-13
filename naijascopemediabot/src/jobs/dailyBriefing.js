import cron from "node-cron";
import { query } from "../utils/db.js";
import { sendText, sendButtons } from "../services/whatsappService.js";
import { applyUserLanguage } from "../services/languageService.js";
import { categorizeStory } from "../services/newsService.js";
import { logger } from "../utils/logger.js";
import { SITE_URL } from "../config/constants.js";

const sentToday = new Set();

function buildPersonalizedBriefing(items, user) {
  const interest = user.primary_interest?.toLowerCase();
  const dayStr   = new Date().toLocaleDateString("en-GB", {
    timeZone: "Africa/Lagos",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const divider  = "─────────────────";

  let sorted = [...items];
  if (interest) {
    sorted.sort((a, b) => {
      const aMatch = (a.title || "").toLowerCase().includes(interest) ? -1 : 0;
      const bMatch = (b.title || "").toLowerCase().includes(interest) ? -1 : 0;
      return aMatch - bMatch;
    });
  }

  const top5  = sorted.slice(0, 5);
  const lines = top5.map((item, i) => {
    const { emoji } = categorizeStory(item);
    return `${i + 1}. ${emoji} ${item.title}\n${item.link}`;
  });

  return [
    `NaijaScope Media — Morning Intelligence Briefing`,
    `${dayStr}`,
    divider,
    ...lines,
    divider,
    `For full coverage and in-depth reports, visit NaijaScope Media at ${SITE_URL}`,
  ].join("\n\n");
}

export async function sendDailyBriefings(fetchRSSItems) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const res = await query(
      `SELECT u.whatsapp_number, u.language_pref, u.primary_interest
       FROM users u
       JOIN user_subscriptions s ON u.whatsapp_number = s.whatsapp_number
       WHERE s.subscription_type = 'daily_digest'`
    );
    const subscribers = res.rows;
    if (subscribers.length === 0) return;

    logger.info(`[DIGEST] Sending to ${subscribers.length} subscribers`);
    const items = await fetchRSSItems(true);
    if (items.length === 0) {
      logger.warn("[DIGEST] No RSS items — skipping run");
      return;
    }

    for (const user of subscribers) {
      const key = `${user.whatsapp_number}_digest_${today}`;
      if (sentToday.has(key)) continue;
      try {
        let msg = buildPersonalizedBriefing(items, user);
        if (user.language_pref && user.language_pref !== "en") {
          msg = await applyUserLanguage(msg, user);
        }
        await sendText(user.whatsapp_number, msg);
        await sendButtons(user.whatsapp_number, "Continue reading:", [
          { id: "menu_headlines", title: "Top Headlines"  },
          { id: "menu_football",  title: "Football"       },
          { id: "main_menu",      title: "Full Menu"      },
        ]);
        sentToday.add(key);
        await new Promise(r => setTimeout(r, 1_200));
      } catch (err) {
        logger.error(`[DIGEST] Failed for ${user.whatsapp_number}:`, err.message);
      }
    }

    if (sentToday.size > 5_000) sentToday.clear();
  } catch (err) {
    logger.error("[DIGEST] job error:", err.message);
  }
}

export function startDailyBriefingJob(fetchRSSItems) {
  cron.schedule("0 6 * * *", async () => {
    logger.info("[CRON] Running daily briefing job");
    await sendDailyBriefings(fetchRSSItems);
  }, { timezone: "Africa/Lagos" });
  logger.info("[CRON] Daily briefing scheduled for 06:00 WAT");
}
