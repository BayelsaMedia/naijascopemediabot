import { sendList, sendText, sendButtons } from "../services/whatsappService.js";
import { sendNewsItems, getNewsByCategory, fetchRSSItems } from "../services/newsService.js";
import { query } from "../utils/db.js";
import { logger } from "../utils/logger.js";
import { CATEGORY_META } from "../config/constants.js";

// ── Step 1: Send interest-picker on first visit ───────────────────────────────
export async function sendOnboardingWelcome(to) {
  await sendText(
    to,
    "Welcome to NaijaScope 🇳🇬\n\nNigeria's most intelligent AI newsroom — right here on WhatsApp.\n\nBefore we begin: what kind of news matters most to you?"
  );
  await sendList(
    to,
    "Choose your primary interest and I'll personalise everything for you from the start.",
    "Choose My Interest",
    [{
      title: "What do you follow most?",
      rows: [
        { id: "onboard_politics",     title: "🏛️ Politics & Government",  description: "Governance, policy, NASS"         },
        { id: "onboard_sports",       title: "⚽ Sports & Football",        description: "Super Eagles, NPFL, EPL"          },
        { id: "onboard_oil",          title: "🛢️ Oil, Gas & Economy",      description: "Crude, energy, markets"           },
        { id: "onboard_crime",        title: "🚨 Crime & Security",         description: "Law enforcement, justice"         },
        { id: "onboard_entertainment",title: "🎬 Entertainment",            description: "Nollywood, music, celebrity"      },
        { id: "onboard_general",      title: "📰 General News",             description: "A bit of everything — mix it up!" },
      ],
    }]
  );
}

// ── Step 2: Handle their interest pick, send first personalized news ──────────
export async function completeOnboarding(to, category, userRow) {
  try {
    await query(
      "UPDATE users SET primary_interest = $1 WHERE whatsapp_number = $2",
      [category, to]
    );
  } catch (err) {
    logger.warn("completeOnboarding DB update failed:", err.message);
  }

  const { label, emoji } = CATEGORY_META[category] || { label: "Nigerian", emoji: "📰" };
  await sendText(
    to,
    `${emoji} Perfect — ${label} it is.\n\nHere's your first NaijaScope briefing. I'll always put what matters to you first from here on. 🇳🇬`
  );

  const items = category === "general"
    ? (await fetchRSSItems()).slice(0, 5)
    : await getNewsByCategory(category);

  await sendNewsItems(to, items, `${emoji} Your first ${label} briefing:`, { ...userRow, primary_interest: category });
}
