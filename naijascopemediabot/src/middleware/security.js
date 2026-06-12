import crypto from "crypto";

/**
 * Verify Meta's HMAC-SHA256 webhook signature.
 * Returns false if verification fails, true if it passes, undefined if skipped (dev mode).
 * Does NOT send any HTTP response or throw — the caller handles the response.
 * If WHATSAPP_APP_SECRET is unset (dev mode), verification is skipped (returns undefined).
 */
export function verifyWebhookSignature(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return undefined; // dev mode — skip

  const sig = req.headers["x-hub-signature-256"];
  if (!sig) {
    return false;
  }

  const buf = req.rawBody;
  if (!buf) {
    return false;
  }

  const expected = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(buf)
    .digest("hex");

  const sigBuf      = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);

  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return false;
  }

  return true;
}

/**
 * Sanitize user text input.
 * Strips control characters and truncates to a safe length.
 */
export function sanitizeInput(text, maxLength = 1_000) {
  if (typeof text !== "string") return "";
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim()
    .slice(0, maxLength);
}

/**
 * Validate a WhatsApp phone number — digits only, 10–15 characters.
 */
export function isValidPhone(number) {
  return /^\d{10,15}$/.test(number);
}
