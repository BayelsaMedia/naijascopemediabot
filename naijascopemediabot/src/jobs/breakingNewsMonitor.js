import cron from "node-cron";
import { getSubscribers, sendBreakingAlert } from "../services/alertService.js";
import { checkKeywordAlerts } from "../services/newsService.js";
import { logger } from "../utils/logger.js";

const seenLinks = new Set();
const MAX_SEEN  = 300;
const SEED_SIZE = 15;

export function startBreakingNewsMonitor(fetchRSSItems) {
  // Seed seen links on startup so we don't re-alert on existing articles
  fetchRSSItems()
    .then(items => items.slice(0, SEED_SIZE).forEach(i => seenLinks.add(i.link)))
    .catch(() => {});

  cron.schedule("*/5 * * * *", async () => {
    try {
      const subscribers = await getSubscribers("breaking_news");
      const items       = await fetchRSSItems(true);
      const fresh       = items.filter(item => !seenLinks.has(item.link));
      if (fresh.length === 0) return;

      // Maintain seen-set size
      fresh.forEach(item => seenLinks.add(item.link));
      if (seenLinks.size > MAX_SEEN) {
        const arr = [...seenLinks];
        arr.slice(0, arr.length - Math.floor(MAX_SEEN / 2)).forEach(l => seenLinks.delete(l));
      }

      // Push to breaking-news subscribers
      if (subscribers.length > 0) {
        for (const item of fresh.slice(0, 2)) {
          await sendBreakingAlert(item, subscribers);
        }
      }

      // Fire keyword alerts for any subscriber who has matching keywords
      await checkKeywordAlerts(fresh);
    } catch (err) {
      logger.error("[BREAKING NEWS MONITOR] error:", err.message);
    }
  });

  logger.info("[CRON] Breaking news monitor started (every 5 min)");
}
