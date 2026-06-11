import Groq from "groq-sdk";
import { logger } from "../utils/logger.js";
import { PROMPT_EN, PROMPT_PIDGIN } from "../prompts/systemPrompts.js";
import { MAX_CONVERSATION_USERS } from "../config/constants.js";

let _groq = null;

export function getGroq() {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set");
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

const conversationHistory = new Map();

export async function getAIResponse(userId, userMessage, userRow) {
  try {
    const groq = getGroq();
    const lang = userRow?.language_pref || "en";
    const isPidgin = lang === "pidgin";

    if (!conversationHistory.has(userId)) {
      conversationHistory.set(userId, []);
      if (conversationHistory.size > MAX_CONVERSATION_USERS)
        conversationHistory.delete(conversationHistory.keys().next().value);
    }

    const history = conversationHistory.get(userId);
    let sys = isPidgin ? PROMPT_PIDGIN : PROMPT_EN;
    if (userRow?.location_state) sys += ` User is from ${userRow.location_state}.`;

    const messages = [
      { role: "system",    content: sys },
      ...history,
      { role: "user",      content: userMessage },
    ];

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      max_tokens: 300,
    });

    const response = completion.choices[0].message.content;
    history.push({ role: "user",      content: userMessage });
    history.push({ role: "assistant", content: response });
    if (history.length > 20) history.splice(0, history.length - 20);

    return response;
  } catch (err) {
    logger.error("getAIResponse error:", err.message);
    return "Abeg — my brain dey process something heavy. Try again in a sec 🤔";
  }
}

export function clearHistory(userId) {
  conversationHistory.delete(userId);
}
