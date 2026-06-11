import { logger } from "../utils/logger.js";
import { getGroq } from "./aiService.js";
import { PROMPT_FACT_CHECK } from "../prompts/systemPrompts.js";

export async function verifyClaim(claim) {
  try {
    const groq = getGroq();
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: PROMPT_FACT_CHECK },
        { role: "user",   content: `Fact check this claim: ${claim}` },
      ],
      max_tokens: 300,
    });

    const result = completion.choices[0].message.content.trim();
    const upper  = result.toUpperCase();

    const verdict = upper.startsWith("FALSE")
      ? "❌ FALSE"
      : upper.startsWith("TRUE")
      ? "✅ TRUE"
      : "⚠️ UNVERIFIED";

    return `🔍 NaijaScope Fact-Check:\n\n${verdict}\n\n${result}\n\n— NaijaScope Media`;
  } catch (err) {
    logger.error("verifyClaim error:", err.message);
    return "Our fact-checkers are momentarily unavailable 🔍\nPlease try again shortly.";
  }
}
