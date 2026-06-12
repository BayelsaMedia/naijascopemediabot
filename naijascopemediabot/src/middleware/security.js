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

// ── 2a. Identity / Impersonation Detection ────────────────────────────────────
const IMPERSONATION_PATTERNS = [
  /\bi\s*(am|'m)\s*(the\s*)?(ceo|chief\s*executive|founder|owner|admin|administrator|editor|developer|moderator|mod|staff|manager|director)\b/i,
  /\bi\s*work\s*(for|at|with)\s*naijascope/i,
  /\bi\s*(am|'m)\s*naijascope/i,
  /\bi\s*(am|'m)\s*(a|an)\s*(naijascope|staff|editor|developer|moderator|admin)\b/i,
  /\bthis\s*is\s*(the\s*)?(ceo|founder|owner|admin|editor)\b/i,
  /\bnaijascope\s*(staff|team|admin|editor|developer)\b/i,
];

/**
 * Detect if a message contains an identity/authority impersonation claim.
 * Returns true if impersonation is detected.
 */
export function detectImpersonation(text) {
  if (typeof text !== "string") return false;
  return IMPERSONATION_PATTERNS.some(pattern => pattern.test(text));
}

// ── 2b. Prompt Injection / Jailbreak Detection ────────────────────────────────
const INJECTION_PATTERNS = [
  /ignore\s*(all\s*)?(previous|prior|above|your)\s*(instructions?|rules?|prompts?|directives?)/i,
  /you\s*(are\s*now|must\s*now|will\s*now|should\s*now)\s*(act|behave|be|pretend|play|roleplay|respond)/i,
  /act\s*as\s*(if\s*(you\s*(are|were)|there\s*(are|were)\s*no)|\w+\s*(without|with\s*no))/i,
  /pretend\s*(you\s*(are|have\s*no)|there\s*(are|were)\s*no)/i,
  /your\s*(new\s*)?(instructions?|rules?|system\s*prompt|persona|role|identity|purpose)\s*(are|is|have\s*been|were)\s*(changed|updated|replaced|overridden|now)/i,
  /forget\s*(everything|all|your|previous|prior)/i,
  /disregard\s*(all|your|previous|prior|the)\s*(instructions?|rules?|prompts?)/i,
  /you\s*(no\s*longer|don'?t\s*have\s*to)\s*(follow|obey|adhere)/i,
  /reveal\s*(your|the)\s*(system\s*prompt|instructions?|prompt|training|source\s*code)/i,
  /what\s*(are|is)\s*(your|the)\s*(system\s*prompt|instructions?|rules?|training\s*data)/i,
  /speak\s*(in\s*)?(a\s*different|another)\s*persona/i,
  /\bdan\b.*\bmode\b/i,
  /jailbreak/i,
  /bypass\s*(your|the|all)\s*(filter|restriction|rule|safeguard|guideline)/i,
];

/**
 * Detect prompt injection or jailbreak attempts.
 * Returns true if an attempt is detected.
 */
export function detectPromptInjection(text) {
  if (typeof text !== "string") return false;
  return INJECTION_PATTERNS.some(pattern => pattern.test(text));
}

// ── 2f. Harmful Content Detection ─────────────────────────────────────────────
const HARMFUL_PATTERNS = [
  /\b(kill|murder|shoot|stab|bomb|attack|rape|molest|assault)\s*(you|him|her|them|everyone|yourself|myself|myself)\b/i,
  /\bi('?ll| will| am going to| gonna)\s*(kill|murder|shoot|stab|hurt|harm|attack|rape|destroy)\b/i,
  /\b(fuck|shit|bitch|bastard|asshole|cunt|dick|pussy)\s*(you|off|this|that|your|him|her|them)\b/i,
  /\b(nigger|faggot|retard|spastic)\b/i,
  /\b(blow\s*up|detonate|explosive|suicide\s*bomb|ied)\b/i,
  /send\s*(me\s*)?(nude|naked|porn|sex\s*tape|explicit)/i,
  /\b(child\s*(porn|sex|abuse|exploitation)|csam|cp\s+image)\b/i,
  /\b(threaten|threatening|threat)\s*(to\s*)?(kill|harm|hurt|rape|destroy)/i,
];

/**
 * Detect abusive, threatening, sexually explicit, or violence-promoting content.
 * Returns true if harmful content is detected.
 */
export function detectHarmfulContent(text) {
  if (typeof text !== "string") return false;
  return HARMFUL_PATTERNS.some(pattern => pattern.test(text));
}
