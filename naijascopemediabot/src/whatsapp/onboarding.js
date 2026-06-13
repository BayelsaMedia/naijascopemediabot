import { sendList, sendText, sendButtons } from "../services/whatsappService.js";
import { sendNewsItems, getNewsByCategory, fetchRSSItems } from "../services/newsService.js";
import { query } from "../utils/db.js";
import { logger } from "../utils/logger.js";
import { CATEGORY_META } from "../config/constants.js";

// ── Step 1: Send interest-picker on first visit ───────────────────────────────
export async function sendOnboardingWelcome(to) {
  await sendText(
    to,
    "Welcome to NaijaScope Media — Nigeria's professional digital news and intelligence service, delivered directly to your WhatsApp.\n\nTo personalise your experience, please indicate the category of news that matters most to you."
  );
  await sendList(
    to,
    "Select your primary area of interest and NaijaScope Media will tailor your briefings accordingly.",
    "Select My Interest",
    [{
      title: "Select Your Primary Interest",
      rows: [
        { id: "onboard_politics",      title: "Politics & Governance",  description: "Government, policy, National Assembly"  },
        { id: "onboard_sports",        title: "Sports & Football",       description: "Super Eagles, NPFL, Premier League"     },
        { id: "onboard_oil",           title: "Oil, Gas & Economy",      description: "Crude oil, energy markets"              },
        { id: "onboard_crime",         title: "Crime & Security",        description: "Law enforcement, judiciary"             },
        { id: "onboard_entertainment", title: "Entertainment",           description: "Nollywood, music, arts"                 },
        { id: "onboard_general",       title: "General News",            description: "A broad mix of national coverage"       },
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

  const { label, emoji } = CATEGORY_META[category] || { label: "Nigerian", emoji: "" };
  await sendText(
    to,
    `Your interest has been set to ${label}. NaijaScope Media will prioritise ${label} coverage in all your briefings.\n\nHere is your first personalised news summary.`
  );

  const items = category === "general"
    ? (await fetchRSSItems()).slice(0, 5)
    : await getNewsByCategory(category);

  await sendNewsItems(to, items, `${emoji} ${label} — Your First Briefing:`.trim(), { ...userRow, primary_interest: category });
}
