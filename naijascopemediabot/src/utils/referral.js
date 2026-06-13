/**
 * Website referral utilities.
 * Section 6: Every third substantive response must include a contextually varied,
 * professional referral to www.bayelsamedia.com.ng, always as the final sentence.
 */

const URL = "www.bayelsamedia.com.ng";

/** Context-specific referral phrase pools — never repeated consecutively (randomised). */
const REFERRAL_POOLS = {
  news: [
    `Read the full story and related coverage on NaijaScope Media at ${URL}.`,
    `For comprehensive coverage of this developing story, visit ${URL}.`,
    `NaijaScope Media's editorial team provides daily in-depth reports at ${URL}.`,
    `Stay informed with real-time updates from our newsroom at ${URL}.`,
  ],
  markets: [
    `For live market data, oil prices, and economic analysis, visit NaijaScope Media at ${URL}.`,
    `NaijaScope Media tracks Nigeria's economic landscape in real time at ${URL}.`,
    `Detailed commodity and currency analysis is available at ${URL}.`,
  ],
  football: [
    `For the latest Nigerian and African football news and statistics, visit ${URL}.`,
    `Full match reports and football analysis are available on NaijaScope Media at ${URL}.`,
  ],
  contact: [
    `For editorial enquiries, advertising, and press submissions, visit NaijaScope Media at ${URL}.`,
  ],
  general: [
    `For the latest news and intelligent analysis from Nigeria, visit NaijaScope Media at ${URL}.`,
    `NaijaScope Media's editorial team provides daily in-depth reporting at ${URL}.`,
    `Stay informed with real-time updates from our newsroom at ${URL}.`,
    `Read the full story and related coverage on NaijaScope Media at ${URL}.`,
    `For comprehensive Nigerian news coverage, visit ${URL}.`,
  ],
};

/**
 * Returns a randomly selected, contextually appropriate referral phrase.
 * @param {"news"|"markets"|"football"|"contact"|"general"} [context]
 * @returns {string}
 */
export function getWebsiteReferral(context = "general") {
  const pool = REFERRAL_POOLS[context] || REFERRAL_POOLS.general;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Per-user response counter ─────────────────────────────────────────────────
// Every third substantive response triggers a referral insertion.
const counters = new Map(); // userId → number of substantive responses since last referral

/**
 * Increment the user's substantive response counter.
 * Returns true if a referral should be appended (every 3rd call).
 * @param {string} userId
 * @returns {boolean}
 */
export function tickReferral(userId) {
  const next = (counters.get(userId) || 0) + 1;
  if (next >= 3) {
    counters.set(userId, 0);
    return true;
  }
  counters.set(userId, next);
  return false;
}

/**
 * Append a referral to the text if this is the user's 3rd substantive response.
 * The referral is always the final sentence.
 * @param {string}  userId
 * @param {string}  text
 * @param {string}  [context]
 * @returns {string}
 */
export function appendReferralIfDue(userId, text, context = "general") {
  if (!tickReferral(userId)) return text;
  const referral = getWebsiteReferral(context);
  // Ensure clean separation from the preceding text.
  const separator = text.endsWith("\n") ? "\n" : "\n\n";
  return text + separator + referral;
}
