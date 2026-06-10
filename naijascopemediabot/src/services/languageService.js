import axios from "axios";
import Groq from "groq-sdk";
import { upsertUser } from "../utils/db.js";
import { logger } from "../utils/logger.js";
import { PROMPT_PIDGIN_TRANSLATE, LANG_NAMES } from "../prompts/systemPrompts.js";

const GOOGLE_TRANSLATE_URL = "https://translation.googleapis.com/language/translate/v2";

export function detectLanguageIntent(text) {
  const t = text.toLowerCase().trim();
  if (t.includes("igbo") || t === "ig") return "ig";
  if (t.includes("yoruba") || t === "yo") return "yo";
  if (t.includes("hausa") || t === "ha") return "ha";
  if (t.includes("pidgin") || t === "pidgin") return "pidgin";
  if (t.includes("english") || t === "en") return "en";
  return null;
}

export async function translateWithGoogle(text, targetLang) {
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) {
    logger.warn("GOOGLE_TRANSLATE_API_KEY not set — skipping translation");
    return null;
  }
  try {
    const res = await axios.post(
      `${GOOGLE_TRANSLATE_URL}?key=${apiKey}`,
      { q: text, target: targetLang, format: "text" },
      { timeout: 8000 }
    );
    return res.data?.data?.translations?.[0]?.translatedText || null;
  } catch (err) {
    logger.error("Google Translate error:", err.message);
    return null;
  }
}

export async function translateWithPidgin(text) {
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: PROMPT_PIDGIN_TRANSLATE },
        { role: "user", content: text },
      ],
      max_tokens: 400,
    });
    return completion.choices[0].message.content;
  } catch (err) {
    logger.error("Pidgin translate error:", err.message);
    return null;
  }
}

export async function translateArticle(text, lang) {
  if (!lang || lang === "en") return text;
  if (lang === "pidgin") return (await translateWithPidgin(text)) || text;
  return (await translateWithGoogle(text, lang)) || text;
}

export async function saveLanguagePreference(whatsappNumber, lang) {
  await upsertUser(whatsappNumber, { language_pref: lang });
}

export async function applyUserLanguage(text, userRow) {
  const lang = userRow?.language_pref || "en";
  return translateArticle(text, lang);
}

export { LANG_NAMES };
