import axios from "axios";
import { upsertUser } from "../utils/db.js";
import { logger } from "../utils/logger.js";

const NIGER_DELTA_STATES = ["bayelsa", "rivers", "delta", "akwa ibom", "cross river", "edo", "imo", "abia", "ondo"];

export async function reverseGeocode(lat, lon) {
  try {
    const res = await axios.get(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      { headers: { "User-Agent": "NaijaScope/1.0" }, timeout: 8000 }
    );
    const addr = res.data.address || {};
    const state = (addr.state || "").toLowerCase().replace(" state", "");
    const lga = addr.county || addr.city || addr.town || addr.village || "";
    return { state, lga, display: `${lga}, ${addr.state || "Nigeria"}` };
  } catch (err) {
    logger.error("reverseGeocode error:", err.message);
    return { state: "", lga: "", display: "Nigeria" };
  }
}

export async function saveUserLocation(whatsappNumber, state, lga) {
  await upsertUser(whatsappNumber, { location_state: state, location_lga: lga });
}

export function isNigerDelta(state) {
  return NIGER_DELTA_STATES.some(s => state.toLowerCase().includes(s));
}

export async function fetchLocalNews(rssItems, state) {
  if (!state) return rssItems.slice(0, 5);
  const stateKw = state.toLowerCase();
  const local = rssItems.filter(item =>
    (item.title || "").toLowerCase().includes(stateKw) ||
    (item.contentSnippet || "").toLowerCase().includes(stateKw)
  );
  return (local.length > 0 ? local : rssItems).slice(0, 5);
}
