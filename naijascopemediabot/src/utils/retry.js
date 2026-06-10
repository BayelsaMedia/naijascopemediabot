import { logger } from "./logger.js";

/**
 * Retry an async function with exponential backoff.
 * @param {Function} fn - async function to retry
 * @param {object} opts
 * @param {number} opts.attempts - max attempts (default 3)
 * @param {number} opts.baseDelayMs - initial delay in ms (default 500)
 * @param {number} opts.maxDelayMs - max delay cap in ms (default 8000)
 * @param {string} opts.label - label for logs
 */
export async function withRetry(fn, { attempts = 3, baseDelayMs = 500, maxDelayMs = 8000, label = "operation" } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      // Don't retry on 4xx client errors (bad request, auth failed, etc.)
      if (status && status >= 400 && status < 500) throw err;

      if (attempt < attempts) {
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        const jitter = Math.floor(Math.random() * 200);
        logger.warn(`[RETRY] ${label} failed (attempt ${attempt}/${attempts}), retrying in ${delay + jitter}ms — ${err.message}`);
        await new Promise(r => setTimeout(r, delay + jitter));
      }
    }
  }
  logger.error(`[RETRY] ${label} failed after ${attempts} attempts`);
  throw lastErr;
}

/**
 * Simple in-memory circuit breaker.
 * Opens after `threshold` consecutive failures, resets after `resetMs`.
 */
export class CircuitBreaker {
  constructor({ threshold = 5, resetMs = 60000, name = "service" } = {}) {
    this.threshold = threshold;
    this.resetMs = resetMs;
    this.name = name;
    this.failures = 0;
    this.openUntil = null;
  }

  isOpen() {
    if (!this.openUntil) return false;
    if (Date.now() > this.openUntil) {
      this.failures = 0;
      this.openUntil = null;
      logger.info(`[CIRCUIT] ${this.name} circuit closed — retrying`);
      return false;
    }
    return true;
  }

  async call(fn, fallback) {
    if (this.isOpen()) {
      logger.warn(`[CIRCUIT] ${this.name} open — using fallback`);
      return fallback ? fallback() : null;
    }
    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (err) {
      this.failures++;
      if (this.failures >= this.threshold) {
        this.openUntil = Date.now() + this.resetMs;
        logger.error(`[CIRCUIT] ${this.name} opened after ${this.failures} failures`);
      }
      throw err;
    }
  }
}
