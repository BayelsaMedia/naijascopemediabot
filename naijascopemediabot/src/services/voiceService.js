import Groq, { toFile } from "groq-sdk";
import { downloadMedia } from "./whatsappService.js";
import { logger } from "../utils/logger.js";

export async function transcribeAudio(mediaId) {
  const { buffer, mimeType } = await downloadMedia(mediaId);
  const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "mp4" : "mpeg";
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const file = await toFile(buffer, `audio.${ext}`, { type: mimeType });
  const result = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3",
    language: "en",
  });
  return result.text;
}

export async function processVoiceIntent(transcription) {
  const t = transcription.toLowerCase();
  if (t.includes("news") || t.includes("headline")) return { intent: "news", text: transcription };
  if (t.includes("football") || t.includes("score")) return { intent: "football", text: transcription };
  if (t.includes("oil price") || t.includes("brent")) return { intent: "oil", text: transcription };
  if (t.includes("weather")) return { intent: "weather", text: transcription };
  return { intent: "ai", text: transcription };
}
