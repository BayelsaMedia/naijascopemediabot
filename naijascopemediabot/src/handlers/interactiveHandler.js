import { sendText } from "../services/whatsappService.js";
import {
  sendMainMenu, sendSubscriptionMenu, sendFootballMenu,
  sendLanguageMenu, sendAfterFootballMenu,
} from "../whatsapp/menus.js";
import { sendNewsItems, fetchRSSItems, fetchOilPrice, fetchExchangeRate } from "../services/newsService.js";
import { fetchEPLStandings, fetchUCLFixtures, fetchTodaysFixtures, fetchLiveScores, fetchNPFLNews, fetchTransferNews, subscribeToTeam } from "../services/footballService.js";
import { saveArticle, getSavedArticles } from "../services/articleService.js";
import { addSubscription } from "../services/alertService.js";
import { saveLanguagePreference, LANG_NAMES } from "../services/languageService.js";
import { upsertUser } from "../utils/db.js";
import { awaitingTeamName, awaitingFactCheck, awaitingHandoff, lastSentNews, track } from "../state/sessionState.js";
import { pollData } from "../jobs/dailyPoll.js";

export async function handleInteractive(from, replyId, userRow) {
  const items = await fetchRSSItems().catch(() => []);

  // ── News ────────────────────────────────────────────────────────────────────
  if (replyId === "top_news" || replyId === "menu_headlines") {
    track(from, "news");
    await sendNewsItems(from, items.slice(0, 5), "📰 Top stories right now:", userRow);
    return;
  }

  if (replyId === "ask_ai" || replyId === "menu_ask_ai") {
    await sendText(from, "Ask me anything about Nigeria, Niger Delta, politics, oil or current affairs — I'm all ears 🤖");
    return;
  }

  if (replyId === "subscribe" || replyId === "menu_subscribe") {
    track(from, "subscribe");
    await sendSubscriptionMenu(from);
    return;
  }

  if (replyId === "main_menu") {
    await sendMainMenu(from);
    return;
  }

  if (replyId === "menu_football") {
    track(from, "football");
    await sendFootballMenu(from);
    return;
  }

  if (replyId === "menu_language") {
    await sendLanguageMenu(from);
    return;
  }

  if (replyId === "menu_factcheck") {
    awaitingFactCheck.add(from);
    await sendText(from, "🔍 Send me the claim you want fact-checked — I'll get on it:");
    return;
  }

  if (replyId === "menu_markets") {
    const [oil, fx] = await Promise.all([fetchOilPrice(), fetchExchangeRate()]);
    await sendText(from, oil);
    await sendText(from, fx);
    return;
  }

  if (replyId === "menu_journalist") {
    track(from, "journalist");
    awaitingHandoff.set(from, true);
    await sendText(from, "🎙️ Sure! Briefly describe what you'd like to discuss with our journalist team:");
    return;
  }

  if (replyId === "menu_saved") {
    const saved = await getSavedArticles(from);
    if (saved.length === 0) {
      await sendText(from, "📚 Your reading list is empty.\n\nAfter reading a story, tap 'Save This' to bookmark it for later!");
    } else {
      const lines = saved.map((a, i) => `${i + 1}. ${a.article_title}\n🔗 ${a.article_url}`).join("\n\n");
      await sendText(from, `🔖 Your saved articles:\n\n${lines}`);
    }
    return;
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────
  if (replyId === "sub_daily") {
    await addSubscription(from, "daily_digest");
    await upsertUser(from, { digest_enabled: true });
    await sendText(from, "☀️ You're in! Daily briefing drops at 7AM WAT, sharp sharp 📰\n\nReply 'unsubscribe' anytime.");
    return;
  }

  if (replyId === "sub_breaking") {
    await addSubscription(from, "breaking_news");
    await upsertUser(from, { breaking_alerts: true });
    await sendText(from, "🔴 Done! You'll be first to know when breaking news drops. No wahala 📡\n\nReply 'unsubscribe' anytime.");
    return;
  }

  if (replyId === "sub_opportunities") {
    await addSubscription(from, "opportunities");
    await sendText(from, "🎓 Subscribed! I'll ping you whenever scholarships, grants or jobs come through. Sharp sharp 🎯");
    return;
  }

  // ── Language ─────────────────────────────────────────────────────────────────
  if (replyId?.startsWith("lang_")) {
    const lang = replyId.replace("lang_", "");
    await saveLanguagePreference(from, lang);
    const langName = LANG_NAMES[lang] || lang;
    await sendText(from, `✅ Language set to ${langName}! All news will arrive in ${langName} from now on. E don happen! 🇳🇬`);
    return;
  }

  // ── Football ─────────────────────────────────────────────────────────────────
  if (replyId === "football_live") {
    await sendText(from, await fetchLiveScores());
    await sendAfterFootballMenu(from);
    return;
  }

  if (replyId === "football_fixtures") {
    await sendText(from, await fetchTodaysFixtures());
    await sendAfterFootballMenu(from);
    return;
  }

  if (replyId === "football_epl") {
    await sendText(from, await fetchEPLStandings());
    await sendAfterFootballMenu(from);
    return;
  }

  if (replyId === "football_ucl") {
    await sendText(from, await fetchUCLFixtures());
    await sendAfterFootballMenu(from);
    return;
  }

  if (replyId === "football_npfl") {
    const npfl = await fetchNPFLNews(items);
    await sendNewsItems(from, npfl, "🏟️ NPFL News:", userRow);
    return;
  }

  if (replyId === "football_transfers") {
    const transfers = await fetchTransferNews(items);
    if (transfers.length > 0) {
      await sendNewsItems(from, transfers, "🔄 Transfer News:", userRow);
    } else {
      await sendText(from, "No transfer stories right now.\n\nCheck www.bayelsamedia.com.ng for the latest 🔗");
    }
    return;
  }

  if (replyId === "football_alerts") {
    awaitingTeamName.add(from);
    await sendText(from, "⚽ Which club do you want alerts for?\n\nJust type the team name — e.g. Enyimba, Arsenal, Manchester City");
    return;
  }

  // ── Post-article actions ──────────────────────────────────────────────────────
  if (replyId === "action_save") {
    const recent = lastSentNews.get(from);
    if (recent?.[0]) {
      await saveArticle(from, recent[0]);
      await sendText(from, "🔖 Saved! Type 'saved' anytime to see your reading list.");
    } else {
      await sendText(from, "No recent article to save. Read a story first!");
    }
    return;
  }

  if (replyId === "action_translate") {
    await sendLanguageMenu(from);
    return;
  }

  if (replyId === "action_more") {
    const recent = lastSentNews.get(from);
    if (recent?.[0]) {
      const words = (recent[0].title || "").split(" ").slice(0, 2).join(" ");
      const more  = items.filter(i => i.link !== recent[0].link && (i.title || "").toLowerCase().includes(words.toLowerCase())).slice(0, 3);
      await sendNewsItems(from, more.length > 0 ? more : items.slice(5, 10), "🔍 More stories:", userRow);
    } else {
      await sendNewsItems(from, items.slice(0, 5), "📰 Latest stories:", userRow);
    }
    return;
  }

  // ── Poll votes ────────────────────────────────────────────────────────────────
  if (replyId?.startsWith("poll_")) {
    const optIdx = parseInt(replyId.split("_")[1]);
    if (pollData.question && optIdx >= 0 && optIdx < pollData.options.length) {
      pollData.votes.set(from, optIdx);
      await sendText(from, `✅ Vote recorded: "${pollData.options[optIdx]}"\n\nType 'poll' to see how others are voting!`);
    }
    return;
  }
}
