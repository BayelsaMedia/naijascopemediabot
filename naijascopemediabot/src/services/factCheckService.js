import Groq from "groq-sdk";
import { logger } from "../utils/logger.js";
import { PROMPT_FACT_CHECK } from "../prompts/systemPrompts.js";

export async function verifyClaim(claim) {
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: PROMPT_FACT_CHECK },
        { role: "user", content: `Fact check this claim: ${claim}` },
      ],
      max_tokens: 300,
    });
    const result = completion.choices[0].message.content;
    const verdict = result.toUpperCase().startsWith("TRUE")
      ? "✅ TRUE"
      : result.toUpperCase().startsWith("FALSE")
      ? "❌ FALSE"
      : "⚠️ UNVERIFIED";
    return `🔍 NaijaScope Fact Check:\n\n${verdict}\n\n${result}\n\nTag: NaijaScope Fact-Check`;
  } catch (err) {
    logger.error("verifyClaim error:", err.message);
    return "Fact check dey sleep 😅 Try again in a sec.";
  }
}
