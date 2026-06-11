import { AsyncLocalStorage } from "async_hooks";

const als = new AsyncLocalStorage();

const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = levels[process.env.LOG_LEVEL || "info"];

function log(level, ...args) {
  if (levels[level] > currentLevel) return;
  const ts    = new Date().toISOString();
  const store = als.getStore();
  const id    = store?.reqId ? ` [${store.reqId}]` : "";
  const out   = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  console[out](`[${ts}] [${level.toUpperCase()}]${id}`, ...args);
}

export const logger = {
  error: (...a) => log("error", ...a),
  warn:  (...a) => log("warn",  ...a),
  info:  (...a) => log("info",  ...a),
  debug: (...a) => log("debug", ...a),
};

/**
 * Run fn inside an async context tagged with a correlation ID.
 * All logger calls within fn (including downstream awaited calls) will include the ID.
 */
export function withCorrelationId(reqId, fn) {
  return als.run({ reqId }, fn);
}
