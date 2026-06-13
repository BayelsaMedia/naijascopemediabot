/**
 * Module B — Search News Flow
 *
 * Provides keyword search over the NaijaScope RSS feed with:
 *   - Session state (3-minute expiry, pagination, duplicate-keyword cache)
 *   - Ranked results (title matches rank above body-only matches)
 *   - Search history (last 5 per user in DB)
 *   - Trending analytics (search_analytics table)
 *   - Full edge-case handling (stop words, RSS failure, abandonment)
 */

import { fetchRSSItems } from "./newsService.js";
import { query } from "../utils/db.js";
import { sendText, sendButtons, sendList } from "./whatsappService.js";
import { sendMainMenu } from "../whatsapp/menus.js";
import { logger } from "../utils/logger.js";
import { SITE_URL } from "../config/constants.js";
import { searchSessions, searchHistoryMenu } from "../state/sessionState.js";

const PAGE_SIZE     = 4;
const SESSION_TTL   = 3 * 60_000;  // 3 minutes
const DUPE_CACHE_MS = 2 * 60_000;  // same keyword within 2 min → cached results
const DIVIDER       = "────────────────────────";

// ── Stop-words list (B5) ──────────────────────────────────────────────────────
const STOP_WORDS = new Set([
  "the","and","is","a","an","of","in","for","on","at","to","it","this","that",
  "was","are","be","been","by","or","as","but","with","from","not","we","you",
  "he","she","they","i","me","my","our","its","their","do","does","did","has",
  "have","had","will","would","could","should","what","when","where","who",
  "why","how","all","just","also","more","so","if","then","than","about","up",
]);

// ── Keyword sanitiser (B5 — strips HTML + injection chars) ───────────────────
export function sanitiseKeyword(raw) {
  return String(raw)
    .replace(/<[^>]*>/g, "")
    .replace(/[<>'";&|`$(){}[\]\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

export function isStopWordsOnly(keyword) {
  const words = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every(w => STOP_WORDS.has(w));
}

function isSessionAlive(session) {
  return session && Date.now() - session.lastActivity < SESSION_TTL;
}

// ── RSS filter + rank ─────────────────────────────────────────────────────────
function filterAndRank(items, keyword) {
  const kw     = keyword.toLowerCase();
  const title  = [];
  const body   = [];

  for (const item of items) {
    const inTitle   = (item.title             || "").toLowerCase().includes(kw);
    const inSnippet = (item.contentSnippet    || item.content || "").toLowerCase().includes(kw);
    const inCats    = (item.categories        || []).some(c => c.toLowerCase().includes(kw));
    const inCreator = (item.creator           || "").toLowerCase().includes(kw);

    if (inTitle)                        title.push(item);
    else if (inSnippet || inCats || inCreator) body.push(item);
  }
  return [...title, ...body];
}

// ── Results page builder ──────────────────────────────────────────────────────
function buildPage(results, keyword, pageIndex) {
  const start      = pageIndex * PAGE_SIZE;
  const page       = results.slice(start, start + PAGE_SIZE);
  const total      = results.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const isLast     = start + PAGE_SIZE >= total;

  const lines = page.map((item, i) => {
    const excerpt = (item.contentSnippet || item.summary || "")
      .replace(/\n/g, " ").trim().slice(0, 120);
    const url = item.link || SITE_FULL_URL;
    return `${start + i + 1}. ${item.title}\n   ${excerpt ? excerpt + "\n   " : ""}${url}`;
  }).join("\n\n");

  const pageInfo  = totalPages > 1 ? ` Page ${pageIndex + 1}/${totalPages}.` : "";
  const header    = `SEARCH RESULTS — "${keyword}"\nNaijaScope Media found ${total} matching ${total === 1 ? "story" : "stories"}.${pageInfo}`;

  return { header, lines, isLast, page, total };
}

// ── B3 Step 1: Start search ───────────────────────────────────────────────────
export async function startSearch(from) {
  searchSessions.set(from, {
    step: "awaiting_keyword",
    keyword: "",
    results: [],
    pageIndex: 0,
    lastActivity: Date.now(),
    lastSearchedAt: null,
  });
  await sendText(from, "What topic or keyword would you like to search for? Enter a word or phrase and NaijaScope Media will find the most relevant stories for you.");
}

// ── B3 Step 2: Receive keyword (called from index.js multi-step check) ────────
export async function runSearchFlow(from, rawText, userRow) {
  const session = searchSessions.get(from);
  if (!session || !isSessionAlive(session)) {
    searchSessions.delete(from);
    await sendMainMenu(from, userRow);
    return;
  }

  // Abandonment: greeting or menu trigger (B5)
  const lower = rawText.trim().toLowerCase();
  const ABANDON_TRIGGERS = new Set(["hi","hello","hey","start","menu","help","main menu"]);
  if (ABANDON_TRIGGERS.has(lower)) {
    searchSessions.delete(from);
    await sendMainMenu(from, userRow);
    return;
  }

  const keyword = sanitiseKeyword(rawText);

  if (keyword.length < 2) {
    session.lastActivity = Date.now();
    await sendText(from, "Please enter a valid search term of at least two characters.");
    return;
  }

  if (isStopWordsOnly(keyword)) {
    session.lastActivity = Date.now();
    await sendText(from, "Your search term is too general. Please try a more specific keyword, such as a person's name, a location, or a topic.");
    return;
  }

  await performSearch(from, keyword, userRow);
}

// ── B3 Step 3+4: Fetch, filter, display ───────────────────────────────────────
export async function performSearch(from, keyword, userRow) {
  const session = searchSessions.get(from) || {};

  // Duplicate keyword within 2 minutes — serve from cache (B5)
  if (
    session.keyword === keyword.toLowerCase() &&
    session.results?.length > 0 &&
    session.lastSearchedAt &&
    Date.now() - session.lastSearchedAt < DUPE_CACHE_MS
  ) {
    searchSessions.set(from, { ...session, pageIndex: 0, lastActivity: Date.now() });
    await showSearchPage(from, 0);
    return;
  }

  let items = [];
  try {
    items = await fetchRSSItems();
    if (!Array.isArray(items)) items = [];
  } catch (err) {
    logger.error("[SEARCH] RSS fetch failed:", err.message);
    searchSessions.set(from, { step: "idle", keyword: "", results: [], pageIndex: 0, lastActivity: Date.now() });
    await sendText(from, "NaijaScope Media's search service is temporarily unavailable. Please visit www.bayelsamedia.com.ng directly to find the story you are looking for.");
    return;
  }

  const results = filterAndRank(items, keyword);

  searchSessions.set(from, {
    step:           "results_displayed",
    keyword:        keyword.toLowerCase(),
    results,
    pageIndex:      0,
    lastActivity:   Date.now(),
    lastSearchedAt: Date.now(),
  });

  // Persist analytics (non-blocking)
  persistSearchAnalytics(from, keyword, results.length).catch(() => {});
  persistSearchHistory(from, keyword, results.length).catch(() => {});

  await showSearchPage(from, 0);
}

// ── B3 Step 4+5: Show a page of results ──────────────────────────────────────
async function showSearchPage(from, pageIndex) {
  const session = searchSessions.get(from);
  if (!session) return;

  const { results, keyword } = session;

  if (results.length === 0) {
    searchSessions.set(from, { ...session, step: "idle" });
    await sendText(from,
      `No stories were found matching "${keyword}". This may be a topic we have not yet covered, or the term may be too specific. Try a broader keyword, or visit www.bayelsamedia.com.ng to browse all our coverage.`
    );
    await sendButtons(from, "What would you like to do next?", [
      { id: "search_tryagain", title: "Try Again"        },
      { id: "search_browse",   title: "Browse Headlines" },
      { id: "search_main",     title: "Main Menu"        },
    ]);
    return;
  }

  const { header, lines, isLast } = buildPage(results, keyword, pageIndex);
  await sendText(from, `${header}\n${DIVIDER}\n\n${lines}\n${DIVIDER}\nFor full coverage, visit ${SITE_URL}`);

  session.pageIndex    = pageIndex;
  session.step         = "results_displayed";
  session.lastActivity = Date.now();
  searchSessions.set(from, session);

  if (!isLast) {
    await sendButtons(from, "Continue your search:", [
      { id: "search_next", title: "Next 4 Results" },
      { id: "search_new",  title: "New Search"     },
      { id: "search_main", title: "Main Menu"      },
    ]);
  } else if (results.length <= PAGE_SIZE) {
    // Single-page results
    await sendButtons(from, "Continue your search:", [
      { id: "search_new",     title: "New Search"    },
      { id: "search_main",    title: "Main Menu"     },
      { id: "search_website", title: "Visit Website" },
    ]);
  } else {
    // Last page of multi-page
    await sendButtons(from, "Continue your search:", [
      { id: "search_start", title: "Back to Start" },
      { id: "search_new",   title: "New Search"    },
      { id: "search_main",  title: "Main Menu"     },
    ]);
  }
}

// ── Interactive reply handler ─────────────────────────────────────────────────
export async function handleSearchInteractive(from, replyId, userRow) {
  const session = searchSessions.get(from);

  if (replyId === "search_next") {
    if (!session?.results?.length) { await sendMainMenu(from, userRow); return; }
    await showSearchPage(from, (session.pageIndex || 0) + 1);
    return;
  }

  if (replyId === "search_start") {
    if (!session?.results?.length) { await sendMainMenu(from, userRow); return; }
    await showSearchPage(from, 0);
    return;
  }

  if (replyId === "search_new" || replyId === "search_tryagain") {
    await startSearch(from);
    return;
  }

  if (replyId === "search_main") {
    searchSessions.delete(from);
    await sendMainMenu(from, userRow);
    return;
  }

  if (replyId === "search_browse") {
    searchSessions.delete(from);
    const { sendNewsItems } = await import("./newsService.js");
    const items = await fetchRSSItems().catch(() => []);
    await sendNewsItems(from, items.slice(0, 5), null, userRow);
    return;
  }

  if (replyId === "search_website") {
    searchSessions.delete(from);
    await sendText(from, `Visit NaijaScope Media for full coverage at www.bayelsamedia.com.ng`);
    return;
  }

  // B3 Step 6: History item tap → re-run that search
  if (replyId.startsWith("search_history_")) {
    const idx     = parseInt(replyId.replace("search_history_", ""), 10);
    const history = searchHistoryMenu.get(from) || [];
    const keyword = history[idx];
    if (keyword) {
      await performSearch(from, keyword, userRow);
    } else {
      await startSearch(from);
    }
    return;
  }
}

// ── B3 Step 6: /mySearches ────────────────────────────────────────────────────
export async function sendSearchHistory(from, userRow) {
  let rows = [];
  try {
    const res = await query(
      `SELECT keyword, result_count, searched_at
       FROM search_history
       WHERE whatsapp_number = $1
       ORDER BY searched_at DESC
       LIMIT 5`,
      [from]
    );
    rows = res.rows;
  } catch (_) {}

  if (rows.length === 0) {
    await sendText(from, "You have not searched for any topics yet. Type a keyword or phrase to search NaijaScope Media's coverage.");
    return;
  }

  // Store in temp Map for interactive lookup
  const keywords = rows.map(r => r.keyword);
  searchHistoryMenu.set(from, keywords);
  setTimeout(() => searchHistoryMenu.delete(from), 5 * 60_000);

  await sendList(
    from,
    "Tap a topic to re-run that search.",
    "Select Search",
    [{
      title: "Recent Searches",
      rows: rows.map((r, i) => ({
        id:          `search_history_${i}`,
        title:       r.keyword.slice(0, 24),
        description: `${r.result_count} result(s) — ${new Date(r.searched_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`,
      })),
    }],
    { header: "Your Recent Searches" }
  );
}

// ── B4: Trending searches (admin) ─────────────────────────────────────────────
export async function getTrendingSearches(days = 7, limit = 10) {
  const res = await query(
    `SELECT keyword, COUNT(*) as search_count, MAX(searched_at) as last_searched_at
     FROM search_analytics
     WHERE searched_at > NOW() - INTERVAL '${days} days'
     GROUP BY keyword
     ORDER BY search_count DESC, last_searched_at DESC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function persistSearchAnalytics(from, keyword, resultCount) {
  await query(
    "INSERT INTO search_analytics (whatsapp_number, keyword, result_count) VALUES ($1, $2, $3)",
    [from, keyword.toLowerCase().slice(0, 100), resultCount]
  );
}

async function persistSearchHistory(from, keyword, resultCount) {
  await query(
    `INSERT INTO search_history (whatsapp_number, keyword, result_count, searched_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (whatsapp_number, keyword)
     DO UPDATE SET searched_at = NOW(), result_count = $3`,
    [from, keyword.toLowerCase().slice(0, 100), resultCount]
  );
}

// Export for constant used in page builder
const SITE_FULL_URL = "https://www.bayelsamedia.com.ng";
