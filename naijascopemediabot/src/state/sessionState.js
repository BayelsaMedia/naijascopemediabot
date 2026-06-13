import { MAX_PROCESSED_IDS, RATE_LIMIT_MS } from "../config/constants.js";

// ── Message deduplication ─────────────────────────────────────────────────────
const processedMessageIds = new Map(); // id → expiry timestamp

export function trackMessageId(id) {
  const now = Date.now();
  if (processedMessageIds.has(id)) {
    const expiry = processedMessageIds.get(id);
    if (now < expiry) return false; // duplicate within 30s
  }
  processedMessageIds.set(id, now + 30_000); // 30-second dedup window
  // Prune expired entries when the map grows large
  if (processedMessageIds.size > MAX_PROCESSED_IDS) {
    for (const [k, v] of processedMessageIds) {
      if (v < now) processedMessageIds.delete(k);
      if (processedMessageIds.size <= MAX_PROCESSED_IDS) break;
    }
  }
  return true;
}

// ── Per-user rate limiting (AI / voice — simple cooldown) ─────────────────────
const rateLimit = new Map();

export function checkRateLimit(userId) {
  const last = rateLimit.get(userId);
  if (last && Date.now() - last < RATE_LIMIT_MS) return false;
  rateLimit.set(userId, Date.now());
  return true;
}

// ── Sliding-window rate limit: max 20 responses per 10 minutes ────────────────
const WINDOW_MS       = 10 * 60 * 1_000;
const WINDOW_MAX      = 20;
const windowRateLimit = new Map();
const windowWarnSent  = new Set();

export function checkWindowRateLimit(userId) {
  const now        = Date.now();
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
  windowWarnSent.delete(userId);
  return true;
}

// ── 24-hour session suspension (harmful content) ──────────────────────────────
const suspendedUsers = new Map(); // userId → expiry timestamp

export function suspendUser(userId) {
  suspendedUsers.set(userId, Date.now() + 24 * 60 * 60 * 1_000);
}

export function isUserSuspended(userId) {
  const expiry = suspendedUsers.get(userId);
  if (!expiry) return false;
  if (Date.now() >= expiry) { suspendedUsers.delete(userId); return false; }
  return true;
}

// ── Opt-out state (in-memory cache; canonical state is in the DB) ─────────────
const optedOutCache = new Set();   // users who have opted out
const reEngageCache = new Set();   // users who have just re-engaged (do not re-send welcome twice)

export function markOptedOut(userId) {
  optedOutCache.add(userId);
}

export function clearOptedOut(userId) {
  optedOutCache.delete(userId);
  reEngageCache.add(userId);
  setTimeout(() => reEngageCache.delete(userId), 5_000);
}

export function isOptedOut(userId) {
  return optedOutCache.has(userId);
}

export function seedOptedOutUsers(numbers) {
  for (const n of numbers) optedOutCache.add(n);
}

// ── Multi-step user flows ──────────────────────────────────────────────────────
export const tipsInProgress     = new Map();
export const reportsInProgress  = new Map();
export const awaitingTeamName   = new Set();
export const awaitingFactCheck  = new Set();
export const awaitingHandoff    = new Map();

// ── Last-sent news (enables save / translate / more actions) ──────────────────
export const lastSentNews = new Map();

// ── Keyword alerts (in-memory, seeded from DB on startup) ─────────────────────
export const userAlerts = new Map();

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
export const promiseTracker = new Map();

// ── Live breaking mode (admin toggle) ─────────────────────────────────────────
export const breakingLive = { active: false, topic: "" };

// ── Onboarding state ──────────────────────────────────────────────────────────
export const onboardingPending = new Set();

// ── Analytics ─────────────────────────────────────────────────────────────────
export const analytics = {
  totalUsers:     new Set(),
  messagesPerDay: new Map(),
  commandCounts:  new Map(),
  peakHours:      new Array(24).fill(0),
};

export function track(from, command) {
  analytics.totalUsers.add(from);
  const today = new Date().toISOString().slice(0, 10);
  analytics.messagesPerDay.set(today, (analytics.messagesPerDay.get(today) || 0) + 1);
  analytics.peakHours[new Date().getUTCHours()]++;
  if (command) analytics.commandCounts.set(command, (analytics.commandCounts.get(command) || 0) + 1);
}
