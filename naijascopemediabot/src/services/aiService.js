import Groq from "groq-sdk";
import { logger } from "../utils/logger.js";
import { PROMPT_EN, PROMPT_IGBO_ADDENDUM, PROMPT_YORUBA_ADDENDUM } from "../prompts/systemPrompts.js";
import { MAX_CONVERSATION_USERS } from "../config/constants.js";

let _groq = null;

export function getGroq() {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set");
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

const conversationHistory = new Map();

// ── Resolve system prompt by language preference ──────────────────────────────
function resolveSystemPrompt(userRow) {
  const lang     = userRow?.language_pref || "en";
  let   sys      = PROMPT_EN;

  if (lang === "ig")  sys += PROMPT_IGBO_ADDENDUM;
  if (lang === "yo")  sys += PROMPT_YORUBA_ADDENDUM;

  if (userRow?.location_state)   sys += ` The user is located in ${userRow.location_state}.`;
  if (userRow?.primary_interest) sys += ` Their primary news interest is ${userRow.primary_interest}.`;

  return sys;
}

// ── Conversational AI ─────────────────────────────────────────────────────────
export async function getAIResponse(userId, userMessage, userRow) {
  try {
    const groq = getGroq();

    if (!conversationHistory.has(userId)) {
      conversationHistory.set(userId, []);
      if (conversationHistory.size > MAX_CONVERSATION_USERS)
        conversationHistory.delete(conversationHistory.keys().next().value);
    }

    const history  = conversationHistory.get(userId);
    const sys      = resolveSystemPrompt(userRow);

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
    return "NaijaScope Media is unable to process your request at this moment. Please try again shortly or visit www.bayelsamedia.com.ng for the latest news.";
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
          content: "You are a senior journalist at NaijaScope Media writing for a professional Nigerian readership. Given a news headline, explain in exactly three concise sentences why this story matters — with particular relevance to the Niger Delta, Bayelsa State, and South-South Nigeria. Be specific, insightful, and publication-ready. No bullet points, no markdown, plain text only. No emojis.",
        },
        { role: "user", content: `Headline: ${title}` },
      ],
      max_tokens: 200,
    });
    return `Why This Matters:\n\n${completion.choices[0].message.content}\n\n— NaijaScope Editorial`;
  } catch (err) {
    logger.error("getStoryExplainer error:", err.message);
    return "Context analysis is unavailable at this moment. Please visit www.bayelsamedia.com.ng for the full story.";
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
          content: "You are the lead editor at NaijaScope Media. Write a formal, authoritative four-to-five sentence Evening Wrap summarising the day's top Nigerian news stories. The tone must reflect a professional news broadcast — composed, credible, and publication-ready. No bullet points. No markdown. No emojis. Plain text only. Conclude with a sign-off line.",
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
