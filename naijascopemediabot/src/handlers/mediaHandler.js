import { sendText } from "../services/whatsappService.js";
import { sendFootballMenu } from "../whatsapp/menus.js";
import { sendNewsItems, fetchRSSItems, fetchOilPrice } from "../services/newsService.js";
import { getAIResponse, getGroq } from "../services/aiService.js";
import { transcribeAudio, processVoiceIntent } from "../services/voiceService.js";
import { reverseGeocode, saveUserLocation, fetchLocalNews } from "../services/locationService.js";
import { downloadMedia } from "../services/whatsappService.js";
import { checkRateLimit } from "../state/sessionState.js";
import { logger } from "../utils/logger.js";

export async function handleMedia(from, message, userRow) {
  // ── Location share ──────────────────────────────────────────────────────────
  if (message.type === "location") {
    const { latitude, longitude } = message.location;
    await sendText(from, "📍 Got your location! Finding news near you...");
    const geo   = await reverseGeocode(latitude, longitude);
    await saveUserLocation(from, geo.state, geo.lga);
    const items = await fetchRSSItems();
    const local = await fetchLocalNews(items, geo.state);
    await sendNewsItems(from, local, `📰 News for ${geo.display}:`, userRow);
    return;
  }

  // ── Image — AI fact-check ───────────────────────────────────────────────────
  if (message.type === "image") {
    const mediaId = message.image?.id;
    if (!mediaId) {
      await sendText(from, "📷 Got your image! Describe what you need and I'll help 👇");
      return;
    }
    await sendText(from, "📸 Analysing your image...");
    try {
      const { buffer, mimeType } = await downloadMedia(mediaId);
      const base64 = buffer.toString("base64");
      const groq   = getGroq();
      const completion = await groq.chat.completions.create({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
            { type: "text", text: "You are a Nigerian news fact-checker. Analyse this image. Start with REAL, FAKE, or UNVERIFIED. Then 2–3 sentences on visual indicators of authenticity or manipulation. Tag: NaijaScope Fact-Check. Plain text only." },
          ],
        }],
        max_tokens: 250,
      });
      await sendText(from, "📸 NaijaScope Fact-Check:\n\n" + completion.choices[0].message.content);
    } catch (err) {
      logger.error("analyzeImage error:", err.message);
      await sendText(from, "📸 Couldn't analyse that image right now. Describe what you see and I'll help! 🤔");
    }
    return;
  }

  // ── Voice note — transcribe → route ────────────────────────────────────────
  if (message.type === "audio") {
    const mediaId = message.audio?.id;
    if (!mediaId) return;
    await sendText(from, "🎤 Transcribing your voice note...");
    try {
      const transcription = await transcribeAudio(mediaId);
      await sendText(from, `🎤 Heard: "${transcription}"\n\nProcessing...`);
      if (!checkRateLimit(from)) { await sendText(from, "Easy now — give me 3 seconds 😄"); return; }
      const { intent } = processVoiceIntent(transcription);
      if (intent === "news") {
        const items = await fetchRSSItems();
        await sendNewsItems(from, items.slice(0, 5), "📰 Top stories:", userRow);
      } else if (intent === "football") {
        await sendFootballMenu(from);
      } else if (intent === "oil") {
        await sendText(from, await fetchOilPrice());
      } else {
        const reply = await getAIResponse(from, transcription, userRow);
        await sendText(from, reply);
      }
    } catch (err) {
      logger.error("transcribeAudio error:", err.message);
      await sendText(from, "🎤 Couldn't catch that voice note. Please type your message instead! 👇");
    }
    return;
  }
}
