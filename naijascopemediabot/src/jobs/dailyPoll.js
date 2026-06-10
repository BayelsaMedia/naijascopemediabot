import cron from "node-cron";
import Groq from "groq-sdk";
import { getSubscribers } from "../services/alertService.js";
import { sendButtons } from "../services/whatsappService.js";
import { logger } from "../utils/logger.js";

export const pollData = { date: null, question: "", options: [], votes: new Map() };

async function generatePoll() {
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: "Generate one sharp, topical opinion poll question about Nigerian politics, oil sector, or Niger Delta issues. Return ONLY a JSON object with fields: question (string), options (array of exactly 3 short strings, max 20 chars each). No markdown, no explanation.",
      }],
      max_tokens: 150,
    });
    const raw = completion.choices[0].message.content.trim();
    const json = JSON.parse(raw.replace(/```json?|```/g, "").trim());
    return { question: json.question, options: json.options.slice(0, 3) };
  } catch (err) {
    logger.error("generatePoll error:", err.message);
    return {
      question: "How do you rate the current government's handling of oil revenue in Bayelsa?",
      options: ["Excellent", "Average", "Poor"],
    };
  }
}

export async function sendDailyPoll() {
  const today = new Date().toISOString().slice(0, 10);
  if (pollData.date === today) return;

  const subscribers = await getSubscribers("daily_digest");
  if (subscribers.length === 0) return;

  const poll = await generatePoll();
  pollData.date = today;
  pollData.question = poll.question;
  pollData.options = poll.options;
  pollData.votes = new Map();

  logger.info(`[POLL] Sending to ${subscribers.length} subscribers`);
  for (const number of subscribers) {
    try {
      await sendButtons(number, `📊 NaijaScope Daily Poll:\n\n${poll.question}`, [
        { id: "poll_0", title: poll.options[0] },
        { id: "poll_1", title: poll.options[1] },
        { id: "poll_2", title: poll.options[2] },
      ]);
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      logger.error(`[POLL] Send error for ${number}:`, err.message);
    }
  }
}

export function startDailyPollJob() {
  cron.schedule("0 8 * * *", async () => {
    logger.info("[CRON] Running daily poll job");
    await sendDailyPoll();
  }, { timezone: "Africa/Lagos" });
  logger.info("[CRON] Daily poll scheduled for 08:00 WAT");
}

export function getPollResults() {
  if (!pollData.question) return "No poll active today. Check back tomorrow! 📊";
  const total = pollData.votes.size;
  if (total === 0) return `📊 Today's Poll:\n\n${pollData.question}\n\nNo votes yet — be the first!`;
  const counts = [0, 0, 0];
  for (const v of pollData.votes.values()) counts[v]++;
  const lines = pollData.options.map((opt, i) => {
    const pct = total > 0 ? Math.round((counts[i] / total) * 100) : 0;
    return `${opt}: ${pct}% (${counts[i]} votes)`;
  }).join("\n");
  return `📊 Today's Poll:\n\n${pollData.question}\n\n${lines}\n\nTotal votes: ${total}`;
}
