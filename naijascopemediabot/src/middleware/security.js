import crypto from "crypto";

/**
 * Verify Meta's HMAC-SHA256 webhook signature.
 * Rejects requests with missing or mismatched signatures.
 * If WHATSAPP_APP_SECRET is unset (dev mode), verification is skipped.
 */
export function verifyWebhookSignature(req, res, buf) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return; // dev mode — skip

  const sig = req.headers["x-hub-signature-256"];
  if (!sig) {
    res.status(401).json({ error: "Missing X-Hub-Signature-256 header" });
    throw new Error("Missing X-Hub-Signature-256");
  }

  const expected = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(buf)
    .digest("hex");

  // timingSafeEqual requires equal-length buffers — guard explicitly
  const sigBuf      = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);

  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    res.status(401).json({ error: "Invalid webhook signature" });
    throw new Error("Webhook signature mismatch");
  }
}

/**
 * Sanitize user text input.
 * Strips control characters and truncates to a safe length.
 * WhatsApp is not a browser context — HTML-encoding is not applied.
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
