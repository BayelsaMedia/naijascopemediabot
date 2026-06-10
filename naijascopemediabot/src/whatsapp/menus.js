import { sendButtons, sendList, sendText } from "../services/whatsappService.js";

export async function sendWelcomeMessage(to) {
  await sendButtons(
    to,
    "👋 Welcome to NaijaScope Media Bot!\nNigeria's smartest news assistant 🇳🇬\n\nWhat would you like to do?",
    [
      { id: "top_news", title: "📰 Top News" },
      { id: "ask_ai", title: "🤖 Ask AI" },
      { id: "subscribe", title: "📡 Subscribe" },
    ]
  );
}

export async function sendMainMenu(to) {
  await sendList(
    to,
    "🇳🇬 NaijaScope Media Bot\nWhat can I help you with today?",
    "Open Menu",
    [
      {
        title: "📰 News & Info",
        rows: [
          { id: "menu_headlines", title: "Top Headlines", description: "Latest Nigerian news" },
          { id: "menu_football", title: "⚽ Football", description: "Scores, fixtures & tables" },
          { id: "menu_markets", title: "📈 Markets", description: "Oil price & exchange rates" },
          { id: "menu_factcheck", title: "🔍 Fact Check", description: "Verify a claim" },
        ],
      },
      {
        title: "🤖 AI & Tools",
        rows: [
          { id: "menu_ask_ai", title: "Ask AI", description: "Ask me anything" },
          { id: "menu_language", title: "🌍 My Language", description: "Read news in your language" },
          { id: "menu_saved", title: "🔖 Saved Articles", description: "View your bookmarks" },
        ],
      },
      {
        title: "📡 Alerts & Support",
        rows: [
          { id: "menu_subscribe", title: "Subscribe", description: "Daily briefings & breaking news" },
          { id: "menu_journalist", title: "🎙️ Talk to Journalist", description: "Speak to our team" },
        ],
      },
    ]
  );
}

export async function sendReturnMenu(to, newCount = 0) {
  const body = `👋 Welcome back!\n\n${newCount > 0 ? `You have ${newCount} new stories waiting.` : "Good to see you again!"}\n\nWhat would you like?`;
  await sendButtons(to, body, [
    { id: "menu_headlines", title: "📰 New Stories" },
    { id: "menu_football", title: "⚽ Football Update" },
    { id: "main_menu", title: "🏠 Full Menu" },
  ]);
}

export async function sendFootballMenu(to) {
  await sendList(
    to,
    "⚽ NaijaScope Football\nChoose your competition:",
    "View Options",
    [
      {
        title: "🏆 Competitions",
        rows: [
          { id: "football_live", title: "Live Scores", description: "Scores happening now" },
          { id: "football_fixtures", title: "Today's Fixtures", description: "Matches today" },
          { id: "football_npfl", title: "NPFL", description: "Nigerian Professional Football League" },
          { id: "football_epl", title: "Premier League", description: "EPL standings & results" },
          { id: "football_ucl", title: "Champions League", description: "UCL results & fixtures" },
        ],
      },
      {
        title: "⚡ Alerts",
        rows: [
          { id: "football_transfers", title: "Transfer News", description: "Latest transfer rumours" },
          { id: "football_alerts", title: "Team Alerts", description: "Subscribe to your club" },
        ],
      },
    ]
  );
}

export async function sendLanguageMenu(to) {
  await sendList(
    to,
    "🌍 Choose your preferred language.\nI'll deliver all news in this language from now on.",
    "Choose Language",
    [
      {
        title: "Available Languages",
        rows: [
          { id: "lang_en", title: "English", description: "Standard English" },
          { id: "lang_pidgin", title: "Nigerian Pidgin", description: "Na so e be!" },
          { id: "lang_ig", title: "Igbo", description: "Ọ dị mma" },
          { id: "lang_yo", title: "Yoruba", description: "Ẹ káàárọ̀" },
          { id: "lang_ha", title: "Hausa", description: "Sannu da zuwa" },
        ],
      },
    ]
  );
}

export async function sendSubscriptionMenu(to) {
  await sendButtons(
    to,
    "📡 NaijaScope Alerts\nWhat would you like to subscribe to?",
    [
      { id: "sub_daily", title: "☀️ Daily Briefing" },
      { id: "sub_breaking", title: "🔴 Breaking News" },
      { id: "sub_opportunities", title: "🎓 Opportunities" },
    ]
  );
}

export async function sendAfterNewsMenu(to) {
  await sendList(
    to,
    "What would you like to do next?",
    "Choose Action",
    [
      {
        title: "Story Options",
        rows: [
          { id: "action_save", title: "🔖 Save This", description: "Bookmark this story" },
          { id: "action_translate", title: "🌍 Translate", description: "Read in your language" },
          { id: "action_more", title: "🔍 More Like This", description: "Similar stories" },
          { id: "main_menu", title: "🏠 Main Menu", description: "Back to main menu" },
        ],
      },
    ]
  );
}

export async function sendAfterFootballMenu(to) {
  await sendButtons(
    to,
    "What else would you like?",
    [
      { id: "football_fixtures", title: "📅 Today's Fixtures" },
      { id: "football_epl", title: "🏆 League Table" },
      { id: "main_menu", title: "🏠 Main Menu" },
    ]
  );
}
