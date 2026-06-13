import axios from "axios";
import { query } from "../utils/db.js";
import { logger } from "../utils/logger.js";

const FD_BASE = "https://api.football-data.org/v4";
const AF_BASE = "https://v3.football.api-sports.io";

function fdHeaders() {
  return { "X-Auth-Token": process.env.FOOTBALL_DATA_TOKEN };
}
function afHeaders() {
  return { "x-apisports-key": process.env.API_FOOTBALL_KEY };
}

export async function fetchEPLStandings() {
  if (!process.env.FOOTBALL_DATA_TOKEN) return "⚽ Football Data API key not configured yet.\n\nContact admin to enable Premier League standings.";
  try {
    const res = await axios.get(`${FD_BASE}/competitions/PL/standings`, { headers: fdHeaders(), timeout: 8000 });
    const table = res.data.standings[0].table.slice(0, 10);
    const lines = table.map(t => `${t.position}. ${t.team.name} — ${t.points}pts`).join("\n");
    return `🏆 Premier League Standings:\n\n${lines}\n\nwww.bayelsamedia.com.ng`;
  } catch (err) {
    logger.error("fetchEPLStandings error:", err.message);
    return "Couldn't fetch EPL standings right now 😅 Try again shortly.";
  }
}

export async function fetchUCLFixtures() {
  if (!process.env.FOOTBALL_DATA_TOKEN) return "⚽ Football Data API key not configured yet.";
  try {
    const res = await axios.get(`${FD_BASE}/competitions/CL/matches?status=SCHEDULED`, { headers: fdHeaders(), timeout: 8000 });
    const matches = res.data.matches.slice(0, 5);
    if (!matches.length) return "🏆 No upcoming Champions League fixtures found.";
    const lines = matches.map(m => `${m.homeTeam.name} vs ${m.awayTeam.name} — ${new Date(m.utcDate).toDateString()}`).join("\n");
    return `🏆 Champions League Upcoming:\n\n${lines}`;
  } catch (err) {
    logger.error("fetchUCLFixtures error:", err.message);
    return "Couldn't fetch UCL fixtures right now 😅";
  }
}

export async function fetchTodaysFixtures() {
  if (!process.env.API_FOOTBALL_KEY) return "⚽ API-Football key not configured yet.\n\nContact admin to enable live fixtures.";
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await axios.get(`${AF_BASE}/fixtures?date=${today}`, { headers: afHeaders(), timeout: 8000 });
    const fixtures = (res.data.response || []).slice(0, 8);
    if (!fixtures.length) return `📅 No fixtures found for today (${today}).`;
    const lines = fixtures.map(f =>
      `${f.teams.home.name} vs ${f.teams.away.name} — ${f.league.name}\n⏰ ${new Date(f.fixture.date).toLocaleTimeString("en-NG", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit" })} WAT`
    ).join("\n\n");
    return `📅 Today's Fixtures (${today}):\n\n${lines}`;
  } catch (err) {
    logger.error("fetchTodaysFixtures error:", err.message);
    return "Couldn't fetch today's fixtures right now 😅";
  }
}

export async function fetchLiveScores() {
  if (!process.env.API_FOOTBALL_KEY) return "⚽ API-Football key not configured.\n\nContact admin to enable live scores.";
  try {
    const res = await axios.get(`${AF_BASE}/fixtures?live=all`, { headers: afHeaders(), timeout: 8000 });
    const live = (res.data.response || []).slice(0, 6);
    if (!live.length) return "⚽ No live matches right now. Check back during match time!";
    const lines = live.map(f =>
      `${f.teams.home.name} ${f.goals.home ?? "-"} — ${f.goals.away ?? "-"} ${f.teams.away.name} (${f.fixture.status.elapsed ?? "?"}')  ${f.league.name}`
    ).join("\n");
    return `🔴 LIVE SCORES:\n\n${lines}`;
  } catch (err) {
    logger.error("fetchLiveScores error:", err.message);
    return "Couldn't fetch live scores right now 😅";
  }
}

export async function fetchNPFLNews(rssItems) {
  const npflKws = ["NPFL", "Nigerian Premier Football", "Nigeria Premier Football", "Liga Futsal"];
  const filtered = rssItems.filter(i => npflKws.some(kw => (i.title || "").includes(kw))).slice(0, 5);
  return filtered.length > 0 ? filtered : rssItems.slice(0, 3);
}

export async function fetchTransferNews(rssItems) {
  const kws = ["transfer", "sign", "loan", "deal", "move", "Eagles"];
  return rssItems.filter(i => kws.some(kw => (i.title || "").toLowerCase().includes(kw))).slice(0, 5);
}

export async function subscribeToTeam(whatsappNumber, teamName) {
  try {
    await query(
      `INSERT INTO user_subscriptions (whatsapp_number, subscription_type, subscription_value)
       VALUES ($1, 'team_alert', $2)
       ON CONFLICT DO NOTHING`,
      [whatsappNumber, teamName]
    );
    return true;
  } catch (err) {
    logger.error("subscribeToTeam error:", err.message);
    return false;
  }
}

export async function getTeamSubscribers(teamName) {
  const res = await query(
    "SELECT whatsapp_number FROM user_subscriptions WHERE subscription_type = 'team_alert' AND subscription_value ILIKE $1",
    [`%${teamName}%`]
  );
  return res.rows.map(r => r.whatsapp_number);
}
