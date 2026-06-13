/**
 * Language sanitisation utilities.
 * Section 5: Post-processing filter for outgoing messages.
 * Ensures no Nigerian Pidgin English or slang appears in any bot response.
 */

// Ordered pairs: [regex, replacement]
// Longer/more specific phrases must come before shorter ones to avoid partial matches.
const PIDGIN_REPLACEMENTS = [
  // Multi-word phrases first
  [/\bno\s+wahala\b/gi,           "no problem"],
  [/\bno\s+be\s+so\b/gi,          "that is not so"],
  [/\bna\s+so\s+e\s+be\b/gi,      "that is how it is"],
  [/\bna\s+so\b/gi,               "that is correct"],
  [/\be\s+don\s+happen\b/gi,      "it has occurred"],
  [/\be\s+don\b/gi,               "it has"],
  [/\bmake\s+we\b/gi,             "let us"],
  [/\bperson\s+wey\b/gi,          "someone who"],
  [/\bwetin\s+you\b/gi,           "what do you"],
  [/\bhow\s+you\s+dey\b/gi,       "how are you"],
  [/\bsharp\s+sharp\b/gi,         "promptly"],
  [/\bwey\s+get\s+sense\b/gi,     "who is intelligent"],

  // Single-word pidgin terms
  [/\bwetin\b/gi,                 "what"],
  [/\babeg\b/gi,                  "please"],
  [/\boya\b/gi,                   "please proceed"],
  [/\bsabi\b/gi,                  "understand"],
  [/\bwahala\b/gi,                "problem"],
  [/\boga\b/gi,                   "sir"],
  [/\bdey\b/gi,                   "is"],
  [/\bwey\b/gi,                   "that"],
  [/\bsef\b/gi,                   "also"],
  [/\bjapa\b/gi,                  "emigrate"],
  [/\bchop\b/gi,                  "consume"],
  [/\bkpakpa\b/gi,                "quickly"],
  [/\bfashi\b/gi,                 "disregard"],
  [/\byakata\b/gi,                "commotion"],
  [/\bbe\s+like\s+say\b/gi,       "it appears that"],
  [/\bnonso\b/gi,                 ""],
];

/**
 * Remove pidgin phrases from a string, replacing each with a standard English equivalent.
 * @param {string} text
 * @returns {string}
 */
export function sanitiseLanguage(text) {
  if (!text || typeof text !== "string") return text;
  let result = text;
  for (const [pattern, replacement] of PIDGIN_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  // Collapse double spaces introduced by empty replacements
  result = result.replace(/\s{2,}/g, " ").trim();
  return result;
}
