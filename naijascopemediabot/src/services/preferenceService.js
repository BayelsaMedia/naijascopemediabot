import { query } from "../utils/db.js";
import { logger } from "../utils/logger.js";
import { CATEGORY_KEYWORDS } from "../config/constants.js";

/**
 * Increment a user's per-category read count and update their primary_interest.
 * Fire-and-forget — non-critical path, never blocks a response.
 */
export async function trackCategoryRead(whatsappNumber, category) {
  try {
    await query(
      `INSERT INTO user_category_counts (whatsapp_number, category, count, last_read)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (whatsapp_number, category) DO UPDATE
         SET count = user_category_counts.count + 1, last_read = NOW()`,
      [whatsappNumber, category]
    );
    // Refresh primary_interest to whichever category has the highest count
    await query(
      `UPDATE users
       SET primary_interest = (
         SELECT category FROM user_category_counts
         WHERE whatsapp_number = $1
         ORDER BY count DESC LIMIT 1
       )
       WHERE whatsapp_number = $1`,
      [whatsappNumber]
    );
  } catch (err) {
    logger.warn("trackCategoryRead error:", err.message);
  }
}

/**
 * Detect the top N categories present in a list of RSS items.
 * Returns an ordered array of category names, highest first.
 */
export function detectTopCategories(items, topN = 3) {
  const counts = {};
  for (const item of items) {
    const title = (item.title || "").toLowerCase();
    for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
      if (kws.some(kw => title.includes(kw.toLowerCase()))) {
        counts[cat] = (counts[cat] || 0) + 1;
        break; // count each story once per category
      }
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([cat]) => cat);
}

/**
 * Count how many RSS items were published since a given date.
 * Falls back to the full list length if dates are missing.
 */
export function countNewStoriesSince(items, lastSeenDate) {
  if (!lastSeenDate) return items.length;
  const since = new Date(lastSeenDate);
  const recent = items.filter(item => {
    const pub = item.isoDate ? new Date(item.isoDate) : null;
    return pub ? pub > since : false;
  });
  return recent.length > 0 ? recent.length : Math.min(items.length, 8);
}

/**
 * Increment the user's total message count (for analytics / adaptive UX).
 */
export async function incrementMessageCount(whatsappNumber) {
  try {
    await query(
      "UPDATE users SET msg_count = msg_count + 1 WHERE whatsapp_number = $1",
      [whatsappNumber]
    );
  } catch (_) { /* non-critical */ }
}
