import cron from "node-cron";
import { getSubscribers } from "../services/alertService.js";
import { sendBreakingAlert } from "../services/alertService.js";
import { logger } from "../utils/logger.js";

const seenLinks = new Set();

export function startBreakingNewsMonitor(fetchRSSItems) {
  // Seed seen links on startup
  fetchRSSItems()
    .then(items => items.slice(0, 15).forEach(i => seenLinks.add(i.link)))
    .catch(() => {});

  // Check every 5 minutes
  cron.schedule("*/5 * * * *", async () => {
    try {
      const subscribers = await getSubscribers("breaking_news");
      if (subscribers.length === 0) return;

      const items = await fetchRSSItems(true);
      const fresh = items.filter(item => !seenLinks.has(item.link));
      if (fresh.length === 0) return;

      fresh.forEach(item => seenLinks.add(item.link));
      if (seenLinks.size > 300) {
        const arr = [...seenLinks];
        arr.slice(0, arr.length - 150).forEach(l => seenLinks.delete(l));
      }

      for (const item of fresh.slice(0, 2)) {
        await sendBreakingAlert(item, subscribers);
      }
    } catch (err) {
      logger.error("[BREAKING NEWS MONITOR] error:", err.message);
    }
  });

  logger.info("[CRON] Breaking news monitor started (every 5 min)");
}
