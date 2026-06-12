import { MAX_PROCESSED_IDS, RATE_LIMIT_MS } from "../config/constants.js";

// ── Message deduplication ─────────────────────────────────────────────────────
const processedMessageIds = new Set();

export function trackMessageId(id) {
  if (processedMessageIds.has(id)) return false;
  processedMessageIds.add(id);
  if (processedMessageIds.size > MAX_PROCESSED_IDS)
    processedMessageIds.delete(processedMessageIds.values().next().value);
  return true;
}

// ── Per-user rate limiting (AI / voice — simple cooldown) ────────────────────
const rateLimit = new Map();

export function checkRateLimit(userId) {
  const last = rateLimit.get(userId);
  if (last && Date.now() - last < RATE_LIMIT_MS) return false;
  rateLimit.set(userId, Date.now());
  return true;
}

// ── 2d. Sliding-window rate limit: max 20 responses per 10 minutes ────────────
const WINDOW_MS       = 10 * 60 * 1_000; // 10 minutes
const WINDOW_MAX      = 20;               // max responses per window
const windowRateLimit = new Map();        // userId → number[]  (timestamps of recent responses)
const windowWarnSent  = new Set();        // userId — we only send the warning once per block

/**
 * Record a response sent to this user and check if the window limit is exceeded.
 * Returns true  → OK to respond.
 * Returns false → limit exceeded; caller should drop silently (warning already sent once).
 * Returns "warn" → limit just exceeded for the first time; caller should send the warning message.
 */
export function checkWindowRateLimit(userId) {
  const now  = Date.now();
  const timestamps = (windowRateLimit.get(userId) || []).filter(t => now - t < WINDOW_MS);

  if (timestamps.length >= WINDOW_MAX) {
    if (!windowWarnSent.has(userId)) {
      windowWarnSent.add(userId);
      return "warn";
    }
    return false;
  }

  timestamps.push(now);
  windowRateLimit.set(userId, timestamps);
  windowWarnSent.delete(userId); // reset warn flag when window clears
  return true;
}

// ── 2f. 24-hour session suspension (harmful content) ─────────────────────────
const suspendedUsers = new Map(); // userId → expiry timestamp (ms)

/**
 * Suspend a user for 24 hours.
 */
export function suspendUser(userId) {
  suspendedUsers.set(userId, Date.now() + 24 * 60 * 60 * 1_000);
}

/**
 * Check if a user is currently suspended.
 * Auto-clears expired suspensions.
 */
export function isUserSuspended(userId) {
  const expiry = suspendedUsers.get(userId);
  if (!expiry) return false;
  if (Date.now() >= expiry) {
    suspendedUsers.delete(userId);
    return false;
  }
  return true;
}

// ── Multi-step user flows ─────────────────────────────────────────────────────
export const tipsInProgress     = new Map();  // userId → { step, data }
export const reportsInProgress  = new Map();  // userId → { step, data }
export const awaitingTeamName   = new Set();
export const awaitingFactCheck  = new Set();
export const awaitingHandoff    = new Map();

// ── Last-sent news (enables save / translate / more actions) ──────────────────
export const lastSentNews = new Map();

// ── Keyword alerts (in-memory, seeded from DB on startup) ────────────────────
export const userAlerts = new Map();  // userId → Set<string>

export function addUserAlert(userId, keyword) {
  if (!userAlerts.has(userId)) userAlerts.set(userId, new Set());
  userAlerts.get(userId).add(keyword.toLowerCase());
}

export function seedKeywordAlerts(rows) {
  for (const { whatsapp_number, keyword } of rows) {
    addUserAlert(whatsapp_number, keyword);
  }
}

// ── Promise tracker (in-memory, admin-managed) ────────────────────────────────
export const promiseTracker = new Map();  // politician → [{ promise, status, date }]

// ── Live breaking mode (admin toggle) ────────────────────────────────────────
export const breakingLive = { active: false, topic: "" };

// ── Onboarding state ──────────────────────────────────────────────────────────
// Tracks users who have just received the welcome message but not yet picked an interest.
export const onboardingPending = new Set();

// ── Analytics ─────────────────────────────────────────────────────────────────
export const analytics = {
  totalUsers:    new Set(),
  messagesPerDay: new Map(),
  commandCounts: new Map(),
  peakHours:     new Array(24).fill(0),
};

export function track(from, command) {
  analytics.totalUsers.add(from);
  const today = new Date().toISOString().slice(0, 10);
  analytics.messagesPerDay.set(today, (analytics.messagesPerDay.get(today) || 0) + 1);
  analytics.peakHours[new Date().getUTCHours()]++;
  if (command) analytics.commandCounts.set(command, (analytics.commandCounts.get(command) || 0) + 1);
}
