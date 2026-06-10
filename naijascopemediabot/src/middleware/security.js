import crypto from "crypto";

/**
 * Verify Meta's HMAC-SHA256 webhook signature.
 * Meta signs every payload with the app secret — reject anything unsigned.
 */
export function verifyWebhookSignature(req, res, buf) {
  const sig = req.headers["x-hub-signature-256"];
  const secret = process.env.WHATSAPP_APP_SECRET;

  if (!secret) return; // skip if not configured (dev mode)
  if (!sig) {
    res.status(401).json({ error: "Missing signature" });
    throw new Error("Missing X-Hub-Signature-256");
  }

  const expected = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(buf)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    res.status(401).json({ error: "Invalid signature" });
    throw new Error("Webhook signature mismatch");
  }
}

/**
 * Sanitize a user text input — strip control chars, truncate to safe length.
 * Does NOT HTML-encode (WhatsApp is not a browser context).
 */
export function sanitizeInput(text, maxLength = 1000) {
  if (typeof text !== "string") return "";
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim()
    .slice(0, maxLength);
}

/**
 * Validate a WhatsApp phone number — digits only, 10-15 chars.
 */
export function isValidPhone(number) {
  return /^\d{10,15}$/.test(number);
}
