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
    const { latitude, longitude } = message.location || {};
    if (!latitude || !longitude) {
      await sendText(from, "Your location was received but the coordinates could not be read. Please try again or type a city name instead.");
      return;
    }
    await sendText(from, "Location received. Retrieving local news for your area.");
    try {
      const geo   = await reverseGeocode(latitude, longitude);
      await saveUserLocation(from, geo.state, geo.lga);
      const items = await fetchRSSItems();
      const local = await fetchLocalNews(items, geo.state);
      await sendNewsItems(from, local, `NaijaScope News — ${geo.display}:`, userRow);
    } catch (err) {
      logger.error("[MEDIA] Location processing error:", err.message);
      await sendText(from, "Local news could not be retrieved at this moment. Type 'news' for the latest national headlines.");
    }
    return;
  }

  // ── Image — AI fact-check ───────────────────────────────────────────────────
  if (message.type === "image") {
    const mediaId = message.image?.id;
    if (!mediaId) {
      await sendText(from, "Your image has been received. Please describe what you would like help with and NaijaScope Media will assist you.");
      return;
    }
    await sendText(from, "NaijaScope Fact-Check: Analysing your image. Please wait.");
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
            { type: "text", text: "You are a senior Nigerian news fact-checker at NaijaScope Media. Analyse this image. Begin your response with REAL, FAKE, or UNVERIFIED followed by a colon. Then provide two precise sentences stating what you observe and the basis for your assessment. Conclude with: NaijaScope Fact-Check. Plain text only. No emojis." },
          ],
        }],
        max_tokens: 250,
      });
      await sendText(from, "NaijaScope Fact-Check:\n\n" + completion.choices[0].message.content);
    } catch (err) {
      logger.error("[MEDIA] analyzeImage error:", err.message);
      await sendText(from, "The image could not be analysed at this moment. Please describe the claim in text and NaijaScope Media will fact-check it for you.");
    }
    return;
  }

  // ── Voice note — transcribe → route ────────────────────────────────────────
  if (message.type === "audio") {
    const mediaId = message.audio?.id;
    if (!mediaId) {
      await sendText(from, "Your voice note was received. Please type your question and NaijaScope Media will respond.");
      return;
    }
    await sendText(from, "Transcribing your voice note. Please wait.");
    try {
      const transcription = await transcribeAudio(mediaId);
      await sendText(from, `Transcribed: "${transcription}"\n\nProcessing your request.`);
      if (!checkRateLimit(from)) {
        await sendText(from, "Please allow a moment before sending your next message.");
        return;
      }
      const { intent } = processVoiceIntent(transcription);
      if (intent === "news") {
        const items = await fetchRSSItems();
        await sendNewsItems(from, items.slice(0, 5), "NaijaScope — Latest Headlines:", userRow);
      } else if (intent === "football") {
        await sendFootballMenu(from);
      } else if (intent === "oil") {
        await sendText(from, await fetchOilPrice());
      } else {
        const reply = await getAIResponse(from, transcription, userRow);
        await sendText(from, reply);
      }
    } catch (err) {
      logger.error("[MEDIA] transcribeAudio error:", err.message);
      await sendText(from, "Your voice note could not be transcribed. Please type your message and NaijaScope Media will assist you.");
    }
    return;
  }

  // ── Video ──────────────────────────────────────────────────────────────────
  if (message.type === "video") {
    await sendText(from, "Video files cannot be processed directly by this service. If you have a claim you would like fact-checked, please describe it in text and NaijaScope Media will review it.");
    return;
  }

  // ── Document ───────────────────────────────────────────────────────────────
  if (message.type === "document") {
    await sendText(from, "Document files cannot be read directly by this service. Please paste the relevant text here and NaijaScope Media will assist you.");
    return;
  }

  // ── Sticker ────────────────────────────────────────────────────────────────
  if (message.type === "sticker") {
    await sendText(from, "Thank you for your message. Type 'news' for the latest headlines or 'menu' to explore all NaijaScope Media services.");
    return;
  }

  // ── Reaction ───────────────────────────────────────────────────────────────
  if (message.type === "reaction") {
    return;
  }

  // ── Unsupported / unknown ──────────────────────────────────────────────────
  logger.info(`[MEDIA] Unhandled message type: ${message.type} from ${from}`);
  await sendText(from, "This message format is not supported. Please type your question or tap 'menu' to access NaijaScope Media services.");
}
