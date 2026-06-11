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

// ── Per-user rate limiting ────────────────────────────────────────────────────
const rateLimit = new Map();

export function checkRateLimit(userId) {
  const last = rateLimit.get(userId);
  if (last && Date.now() - last < RATE_LIMIT_MS) return false;
  rateLimit.set(userId, Date.now());
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
