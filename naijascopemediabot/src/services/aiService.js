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

// ── Conversational AI ─────────────────────────────────────────────────────────
export async function getAIResponse(userId, userMessage, userRow) {
  try {
    const groq    = getGroq();
    const lang    = userRow?.language_pref || "en";
    const isPidgin = lang === "pidgin";

    if (!conversationHistory.has(userId)) {
      conversationHistory.set(userId, []);
      if (conversationHistory.size > MAX_CONVERSATION_USERS)
        conversationHistory.delete(conversationHistory.keys().next().value);
    }

    const history = conversationHistory.get(userId);
    let sys = isPidgin ? PROMPT_PIDGIN : PROMPT_EN;
    if (userRow?.location_state) sys += ` User is from ${userRow.location_state}.`;
    if (userRow?.primary_interest) sys += ` Their primary news interest is ${userRow.primary_interest}.`;

    const messages = [
      { role: "system",    content: sys },
      ...history,
      { role: "user",      content: userMessage },
    ];

    const completion = await groq.chat.completions.create({
      model:      "llama-3.3-70b-versatile",
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

// ── Story explainer ("Why this matters") ─────────────────────────────────────
export async function getStoryExplainer(title) {
  try {
    const groq = getGroq();
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: "You are a senior Nigerian journalist writing for NaijaScope Media. Given a news headline, explain in exactly 3 concise sentences WHY this story matters — especially to people in the Niger Delta, Bayelsa, and South-South Nigeria. Be specific, insightful, and human. No bullet points, no markdown, plain text only.",
        },
        { role: "user", content: `Headline: ${title}` },
      ],
      max_tokens: 200,
    });
    return `💡 Why this matters:\n\n${completion.choices[0].message.content}\n\n— NaijaScope Editorial`;
  } catch (err) {
    logger.error("getStoryExplainer error:", err.message);
    return "Couldn't generate context right now. Type the headline and ask me — I'll explain it! 🤔";
  }
}

// ── Evening Wrap-Up AI summary ────────────────────────────────────────────────
export async function generateEveningWrap(headlines) {
  try {
    const groq = getGroq();
    const list = headlines.map((h, i) => `${i + 1}. ${h}`).join("\n");
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: "You are the lead editor at NaijaScope Media. Write a warm, intelligent, 4–5 sentence Evening Wrap-Up summarising the day's top Nigerian news stories. Feel like a trusted anchor signing off for the night — not a robot. No bullet points. No markdown. Plain text only. End with a sign-off line.",
        },
        { role: "user", content: `Today's top stories:\n\n${list}` },
      ],
      max_tokens: 350,
    });
    return completion.choices[0].message.content;
  } catch (err) {
    logger.error("generateEveningWrap error:", err.message);
    return null;
  }
}

export function clearHistory(userId) {
  conversationHistory.delete(userId);
}
