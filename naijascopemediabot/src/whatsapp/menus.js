import { sendButtons, sendList, sendText } from "../services/whatsappService.js";

// ── 3a. Welcome / Greeting Message ───────────────────────────────────────────
export async function sendWelcomeMessage(to) {
  await sendList(
    to,
    "Welcome to NaijaScope Media — your trusted source for Niger Delta news, Bayelsa State updates, and national intelligence. Select an option below to get started.",
    "Explore Features",
    [
      {
        title: "News & Updates",
        rows: [
          { id: "welcome_latest",      title: "Latest Headlines",    description: "Get the most recent breaking news"           },
          { id: "welcome_search",      title: "Search News",         description: "Find articles by topic or keyword"           },
          { id: "welcome_niger_delta", title: "Niger Delta Focus",   description: "Stories from the heart of the region"        },
          { id: "welcome_bayelsa",     title: "Bayelsa State News",  description: "Local government and community updates"       },
        ],
      },
      {
        title: "Media & Insights",
        rows: [
          { id: "welcome_market",   title: "Market Pulse",       description: "Nigerian stock market and financial data" },
          { id: "welcome_watch",    title: "Watch & Listen",     description: "Video reports and media content"          },
          { id: "welcome_opinion",  title: "Opinion & Analysis", description: "Editorial perspectives"                   },
        ],
      },
      {
        title: "About & Support",
        rows: [
          { id: "welcome_about",   title: "About NaijaScope", description: "Who we are and our mission"           },
          { id: "welcome_contact", title: "Contact Us",        description: "Reach our editorial team"             },
          { id: "welcome_website", title: "Visit Our Website", description: "Full coverage at bayelsamedia.com.ng" },
        ],
      },
    ],
    {
      header: "NaijaScope Media Intelligence Bot",
      footer: "Powered by NaijaScope Media | www.bayelsamedia.com.ng",
    }
  );
}

// ── 3b. Post-news navigation buttons (Option A) ───────────────────────────────
export async function sendPostNewsButtons(to) {
  await sendButtons(to, "What would you like to do next?", [
    { id: "nav_more_headlines", title: "More Headlines"  },
    { id: "nav_search_topic",   title: "Search Topic"    },
    { id: "nav_visit_website",  title: "Visit Website"   },
  ]);
}

// ── 3b. Post-general navigation buttons (Option B) ───────────────────────────
export async function sendPostGeneralButtons(to) {
  await sendButtons(to, "Is there anything else I can help you with?", [
    { id: "nav_back_menu",     title: "Back to Menu"  },
    { id: "nav_search_news",   title: "Search News"   },
    { id: "nav_visit_website", title: "Visit Website" },
  ]);
}

// ── Smart return menu ─────────────────────────────────────────────────────────
export async function sendReturnMenu(to, newCount = 0, topCategories = []) {
  let body;
  if (newCount > 0 && topCategories.length > 0) {
    const cats = topCategories.slice(0, 2).map(c => c.charAt(0).toUpperCase() + c.slice(1)).join(" and ");
    body = `Welcome back to NaijaScope Media.\n\n${newCount} new ${newCount === 1 ? "story has" : "stories have"} been published since your last visit. The leading themes are ${cats}.\n\nHow may I assist you?`;
  } else if (newCount > 0) {
    body = `Welcome back to NaijaScope Media.\n\n${newCount} new ${newCount === 1 ? "story is" : "stories are"} available since your last visit. Select an option below to continue.`;
  } else {
    body = `Welcome back to NaijaScope Media. You are fully up to date. Select an option below to explore the latest coverage.`;
  }
  await sendButtons(to, body, [
    { id: "menu_headlines", title: "New Stories"      },
    { id: "menu_football",  title: "Football Update"  },
    { id: "main_menu",      title: "Full Menu"        },
  ]);
}

// ── Adaptive main menu ────────────────────────────────────────────────────────
// Personalises the top section based on the user's primary interest.
export async function sendMainMenu(to, userRow = null) {
  const interest = userRow?.primary_interest?.toLowerCase() || "";

  // Build the top news rows — reorder based on interest
  const newsRows = [
    { id: "menu_headlines", title: "Top Headlines",      description: "Latest Nigerian news"         },
    { id: "menu_football",  title: "⚽ Football",         description: "Scores, fixtures & tables"    },
    { id: "menu_markets",   title: "📈 Markets",          description: "Oil price & exchange rates"   },
    { id: "menu_factcheck", title: "🔍 Fact Check",       description: "Verify a claim or image"      },
  ];

  if (interest === "football" || interest === "sports") {
    newsRows.sort((a, b) => (b.id === "menu_football" ? 1 : 0) - (a.id === "menu_football" ? 1 : 0));
  } else if (["politics", "election", "crime"].includes(interest)) {
    // Politics readers get a dedicated row — swap Fact Check position for context
    newsRows.sort((a, b) => (b.id === "menu_headlines" ? 1 : 0) - (a.id === "menu_headlines" ? 1 : 0));
  } else if (interest === "oil" || interest === "environment") {
    newsRows.sort((a, b) => (b.id === "menu_markets" ? 1 : 0) - (a.id === "menu_markets" ? 1 : 0));
  }

  await sendList(
    to,
    "🇳🇬 NaijaScope — What can I help you with today?",
    "Open Menu",
    [
      { title: "📰 News & Intelligence",  rows: newsRows },
      {
        title: "🤖 AI & Tools",
        rows: [
          { id: "menu_ask_ai",   title: "Ask AI",            description: "Ask me anything"             },
          { id: "menu_language", title: "🌍 My Language",    description: "Read news in your language"   },
          { id: "menu_saved",    title: "🔖 Saved Articles", description: "Your reading list"            },
        ],
      },
      {
        title: "📡 Alerts & Support",
        rows: [
          { id: "menu_subscribe",  title: "Subscribe",            description: "Daily briefings & breaking news" },
          { id: "menu_journalist", title: "🎙️ Talk to Journalist", description: "Speak directly to our team"      },
        ],
      },
    ]
  );
}

// ── Football menu ─────────────────────────────────────────────────────────────
export async function sendFootballMenu(to) {
  await sendList(
    to,
    "⚽ NaijaScope Football — Choose your competition:",
    "View Options",
    [
      {
        title: "🏆 Competitions",
        rows: [
          { id: "football_live",      title: "🔴 Live Scores",     description: "Scores happening right now" },
          { id: "football_fixtures",  title: "📅 Today's Fixtures", description: "All matches today"          },
          { id: "football_npfl",      title: "🇳🇬 NPFL",            description: "Nigerian Premier Football"  },
          { id: "football_epl",       title: "🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League",  description: "EPL standings & results"    },
          { id: "football_ucl",       title: "🌟 Champions League", description: "UCL results & fixtures"     },
        ],
      },
      {
        title: "⚡ Alerts",
        rows: [
          { id: "football_transfers", title: "🔄 Transfer News",  description: "Latest transfer rumours" },
          { id: "football_alerts",    title: "🔔 Team Alerts",    description: "Subscribe to your club"  },
        ],
      },
    ]
  );
}

// ── Language menu ─────────────────────────────────────────────────────────────
export async function sendLanguageMenu(to) {
  await sendList(
    to,
    "Select your preferred language. All news briefings and responses will be delivered in your chosen language.",
    "Choose Language",
    [{
      title: "Available Languages",
      rows: [
        { id: "lang_en",     title: "English",         description: "Formal British English (default)"    },
        { id: "lang_pidgin", title: "Nigerian Pidgin",  description: "Nigerian Pidgin English"             },
        { id: "lang_ig",     title: "Igbo",             description: "Igbo language"                       },
        { id: "lang_yo",     title: "Yoruba",           description: "Yoruba language"                     },
        { id: "lang_ha",     title: "Hausa",            description: "Hausa language"                      },
      ],
    }]
  );
}

// ── Subscription menu ─────────────────────────────────────────────────────────
export async function sendSubscriptionMenu(to) {
  await sendButtons(
    to,
    "📡 NaijaScope Alerts — Choose what you'd like to receive:",
    [
      { id: "sub_daily",         title: "☀️ Daily Briefing"   },
      { id: "sub_breaking",      title: "🔴 Breaking News"    },
      { id: "sub_opportunities", title: "🎓 Opportunities"    },
    ]
  );
}

// ── Post-article action menu ──────────────────────────────────────────────────
export async function sendAfterNewsMenu(to) {
  await sendList(
    to,
    "What would you like to do next?",
    "Choose Action",
    [{
      title: "Story Options",
      rows: [
        { id: "action_explainer", title: "💡 Why this matters",  description: "AI context on this story" },
        { id: "action_save",      title: "🔖 Save This",         description: "Add to your reading list" },
        { id: "action_more",      title: "🔍 More Like This",    description: "Related stories"          },
        { id: "main_menu",        title: "🏠 Main Menu",         description: "Back to main menu"        },
      ],
    }]
  );
}

// ── Post-football menu ────────────────────────────────────────────────────────
export async function sendAfterFootballMenu(to) {
  await sendButtons(
    to,
    "What else would you like?",
    [
      { id: "football_fixtures", title: "📅 Today's Fixtures" },
      { id: "football_epl",      title: "🏆 League Table"     },
      { id: "main_menu",         title: "🏠 Main Menu"        },
    ]
  );
}
