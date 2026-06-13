import { sendText, sendButtons } from "../services/whatsappService.js";
import {
  sendMainMenu, sendSubscriptionMenu, sendFootballMenu,
  sendLanguageMenu, sendAfterFootballMenu,
  sendPostNewsButtons, sendPostGeneralButtons,
} from "../whatsapp/menus.js";
import { completeOnboarding } from "../whatsapp/onboarding.js";
import { sendNewsItems, fetchRSSItems, fetchOilPrice, fetchExchangeRate, getNewsByCategory } from "../services/newsService.js";
import { fetchEPLStandings, fetchUCLFixtures, fetchTodaysFixtures, fetchLiveScores, fetchNPFLNews, fetchTransferNews } from "../services/footballService.js";
import { saveArticle, getSavedArticles } from "../services/articleService.js";
import { addSubscription } from "../services/alertService.js";
import { saveLanguagePreference, LANG_NAMES } from "../services/languageService.js";
import { upsertUser } from "../utils/db.js";
import { getStoryExplainer } from "../services/aiService.js";
import { trackCategoryRead } from "../services/preferenceService.js";
import { awaitingTeamName, awaitingFactCheck, awaitingHandoff, lastSentNews, onboardingPending, track } from "../state/sessionState.js";
import { pollData } from "../jobs/dailyPoll.js";
import { SITE_URL } from "../config/constants.js";

export async function handleInteractive(from, replyId, userRow) {
  const items = await fetchRSSItems().catch(() => []);

  // ── Onboarding interest picker ───────────────────────────────────────────────
  if (replyId?.startsWith("onboard_")) {
    const category = replyId.replace("onboard_", "");
    onboardingPending.delete(from);
    await completeOnboarding(from, category, userRow);
    return;
  }

  // ── News ────────────────────────────────────────────────────────────────────
  if (replyId === "top_news" || replyId === "menu_headlines") {
    track(from, "news");
    trackCategoryRead(from, "politics").catch(() => {});
    await sendNewsItems(from, items.slice(0, 5), null, userRow);
    return;
  }

  if (replyId === "ask_ai" || replyId === "menu_ask_ai") {
    await sendText(from, "Please type your question about Nigeria, the Niger Delta, politics, oil and gas, or any other topic within NaijaScope Media's coverage area. The Intelligence Bot will respond promptly.");
    return;
  }

  if (replyId === "subscribe" || replyId === "menu_subscribe") {
    track(from, "subscribe");
    await sendSubscriptionMenu(from);
    return;
  }

  if (replyId === "main_menu") {
    await sendMainMenu(from, userRow);
    return;
  }

  if (replyId === "menu_football") {
    track(from, "football");
    trackCategoryRead(from, "sports").catch(() => {});
    await sendFootballMenu(from);
    return;
  }

  if (replyId === "menu_language") {
    await sendLanguageMenu(from);
    return;
  }

  if (replyId === "menu_factcheck") {
    awaitingFactCheck.add(from);
    await sendText(from, "Please send the claim, statement, or image you would like NaijaScope Media to fact-check.");
    return;
  }

  if (replyId === "menu_markets") {
    trackCategoryRead(from, "oil").catch(() => {});
    const [oil, fx] = await Promise.all([fetchOilPrice(), fetchExchangeRate()]);
    await sendText(from, oil);
    await sendText(from, fx);
    return;
  }

  if (replyId === "menu_journalist") {
    track(from, "journalist");
    awaitingHandoff.set(from, true);
    await sendText(from, "Please briefly describe the matter you would like to discuss with the NaijaScope Media journalist team. A correspondent will be assigned to your enquiry.");
    return;
  }

  if (replyId === "menu_saved") {
    const saved = await getSavedArticles(from);
    if (saved.length === 0) {
      await sendText(from, "Your reading list is currently empty. After reading a story, tap 'Save This' to add it to your bookmarks.");
    } else {
      const lines = saved.map((a, i) => `${i + 1}. ${a.article_title}\n${a.article_url}`).join("\n\n");
      await sendText(from, `NaijaScope Media — Your Saved Articles:\n\n${lines}`);
    }
    return;
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────
  if (replyId === "sub_daily") {
    await addSubscription(from, "daily_digest");
    await upsertUser(from, { digest_enabled: true });
    await sendText(from, "You have been subscribed to the NaijaScope Media Morning Briefing. Your personalised daily intelligence digest will be delivered at 07:00 WAT each morning. Type 'unsubscribe' at any time to cancel.");
    return;
  }

  if (replyId === "sub_breaking") {
    await addSubscription(from, "breaking_news");
    await upsertUser(from, { breaking_alerts: true });
    await sendText(from, "You have been subscribed to NaijaScope Media Breaking News alerts. You will be notified as soon as significant stories are confirmed. Type 'unsubscribe' at any time to cancel.");
    return;
  }

  if (replyId === "sub_opportunities") {
    await addSubscription(from, "opportunities");
    await sendText(from, "You have been subscribed to NaijaScope Media Opportunities alerts. You will be notified of relevant scholarships, grants, fellowships, and employment opportunities as they are published.");
    return;
  }

  // ── Language ─────────────────────────────────────────────────────────────────
  if (replyId?.startsWith("lang_")) {
    const lang     = replyId.replace("lang_", "");
    await saveLanguagePreference(from, lang);
    const langName = LANG_NAMES[lang] || lang;
    await sendText(from, `Your language preference has been updated to ${langName}. NaijaScope Media will deliver your news in ${langName} from this point forward.`);
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
    await sendNewsItems(from, npfl, "NaijaScope — NPFL News:", userRow);
    return;
  }
  if (replyId === "football_transfers") {
    const transfers = await fetchTransferNews(items);
    if (transfers.length > 0) {
      await sendNewsItems(from, transfers, "🔄 Transfer News:", userRow);
    } else {
      await sendText(from, `No transfer stories right now.\n\nCheck ${SITE_URL} for the latest. 🔗`);
    }
    return;
  }
  if (replyId === "football_alerts") {
    awaitingTeamName.add(from);
    await sendText(from, "Please type the name of the club you would like to follow. For example: Enyimba, Arsenal, Manchester City.");
    return;
  }

  // ── Post-article actions ──────────────────────────────────────────────────────
  if (replyId === "action_explainer") {
    const recent = lastSentNews.get(from);
    if (recent?.[0]) {
      await sendText(from, "Generating editorial context. Please wait.");
      const explainer = await getStoryExplainer(recent[0].title);
      await sendText(from, explainer);
    } else {
      await sendText(from, "Please read a story first. Type 'news' for the latest headlines, then use this option to receive editorial context.");
    }
    return;
  }

  if (replyId === "action_save") {
    const recent = lastSentNews.get(from);
    if (recent?.[0]) {
      await saveArticle(from, recent[0]);
      await sendText(from, "The article has been saved to your reading list. Type 'saved' at any time to access your bookmarks.");
    } else {
      await sendText(from, "Please read a story first before saving it. Type 'news' to view the latest headlines.");
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
      const more  = items.filter(i => i.link !== recent[0].link && (i.title || "").toLowerCase().includes(words.toLowerCase())).slice(0, 4);
      await sendNewsItems(from, more.length > 0 ? more : items.slice(5, 10), "NaijaScope — More Stories:", userRow);
    } else {
      await sendNewsItems(from, items.slice(0, 5), null, userRow);
    }
    return;
  }

  // ── Poll votes ────────────────────────────────────────────────────────────────
  if (replyId?.startsWith("poll_")) {
    const optIdx = parseInt(replyId.split("_")[1]);
    if (pollData.question && optIdx >= 0 && optIdx < pollData.options.length) {
      pollData.votes.set(from, optIdx);
      await sendText(from, `Your vote for "${pollData.options[optIdx]}" has been recorded. Type 'poll' to view the current results.`);
    }
    return;
  }

  // ── 3c. Welcome list handlers ─────────────────────────────────────────────────
  if (replyId === "welcome_latest") {
    track(from, "news");
    trackCategoryRead(from, "politics").catch(() => {});
    await sendNewsItems(from, items.slice(0, 5), null, userRow);
    await sendPostNewsButtons(from);
    return;
  }

  if (replyId === "welcome_search") {
    await sendText(from, "Please type the topic you would like to search for. For example: Tinubu, NDDC, oil spill, Super Eagles.");
    return;
  }

  if (replyId === "welcome_niger_delta") {
    track(from, "niger_delta");
    trackCategoryRead(from, "nddc").catch(() => {});
    const ndDeltaItems = [
      ...(await getNewsByCategory("nddc").catch(() => [])),
      ...(await getNewsByCategory("environment").catch(() => [])),
    ].slice(0, 5);
    await sendNewsItems(from, ndDeltaItems.length > 0 ? ndDeltaItems : items.slice(0, 5), "NaijaScope — Niger Delta Focus:", userRow);
    await sendPostNewsButtons(from);
    return;
  }

  if (replyId === "welcome_bayelsa") {
    track(from, "bayelsa");
    const bayelsaItems = items.filter(i =>
      /(bayelsa|yenagoa|ijaw|ogbia|sagbama|nembe|brass)/i.test(i.title + " " + (i.contentSnippet || ""))
    ).slice(0, 5);
    await sendNewsItems(from, bayelsaItems.length > 0 ? bayelsaItems : items.slice(0, 5), "NaijaScope — Bayelsa State News:", userRow);
    await sendPostNewsButtons(from);
    return;
  }

  if (replyId === "welcome_market") {
    trackCategoryRead(from, "oil").catch(() => {});
    const [oil, fx] = await Promise.all([fetchOilPrice(), fetchExchangeRate()]);
    await sendText(from, oil);
    await sendText(from, fx);
    await sendPostGeneralButtons(from);
    return;
  }

  if (replyId === "welcome_watch") {
    await sendText(from, "NaijaScope Media — Watch and Listen\n\nFor video reports, live coverage, and multimedia content, visit NaijaScope Media's full website:\n\nhttps://www.bayelsamedia.com.ng\n\nAll multimedia content is available on the website.");
    await sendPostGeneralButtons(from);
    return;
  }

  if (replyId === "welcome_opinion") {
    track(from, "opinion");
    trackCategoryRead(from, "politics").catch(() => {});
    const opinionItems = await getNewsByCategory("politics").catch(() => items.slice(0, 5));
    await sendNewsItems(from, opinionItems.slice(0, 5), "NaijaScope — Opinion and Analysis:", userRow);
    await sendPostNewsButtons(from);
    return;
  }

  if (replyId === "welcome_about") {
    await sendText(from,
      "About NaijaScope Media\n\nNaijaScope Media is a digital news intelligence platform dedicated to delivering credible, real-time news from Bayelsa State, the Niger Delta region, and across Nigeria.\n\nOur coverage spans politics, oil and gas, crime, the environment, sports, and entertainment — powered by AI and driven by professional journalism.\n\nWebsite: www.bayelsamedia.com.ng\nEmail: admin@bayelsamedia.com.ng\n\nMission: Inform. Engage. Empower."
    );
    await sendPostGeneralButtons(from);
    return;
  }

  if (replyId === "welcome_contact") {
    await sendText(from,
      "Contact NaijaScope Media\n\nWebsite: www.bayelsamedia.com.ng\nEmail: admin@bayelsamedia.com.ng\n\nFor news tips, press enquiries, advertising, or editorial matters, reach our team via email or visit the website.\n\nTo submit an anonymous tip through this service, type 'tip'."
    );
    await sendPostGeneralButtons(from);
    return;
  }

  if (replyId === "welcome_website") {
    await sendText(from, "NaijaScope Media — Full Coverage\n\nFor in-depth reports, investigative journalism, and multimedia content, visit:\n\nhttps://www.bayelsamedia.com.ng");
    await sendPostGeneralButtons(from);
    return;
  }

  // ── 3c. Post-response navigation button handlers ──────────────────────────────
  if (replyId === "nav_more_headlines") {
    track(from, "news");
    trackCategoryRead(from, "politics").catch(() => {});
    await sendNewsItems(from, items.slice(0, 5), "NaijaScope — Latest Headlines:", userRow);
    await sendPostNewsButtons(from);
    return;
  }

  if (replyId === "nav_search_topic" || replyId === "nav_search_news") {
    await sendText(from, "Please type the topic or keyword you would like to search for. For example: Tinubu, NDDC, oil spill, Super Eagles.");
    return;
  }

  if (replyId === "nav_visit_website") {
    await sendText(from, "NaijaScope Media — Full Coverage\n\nhttps://www.bayelsamedia.com.ng");
    return;
  }

  if (replyId === "nav_back_menu") {
    await sendMainMenu(from, userRow);
    return;
  }
}
