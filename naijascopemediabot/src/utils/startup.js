import { logger } from "./logger.js";
import { query } from "./db.js";
import { seedKeywordAlerts } from "../state/sessionState.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS    = ["001_initial_schema.sql", "002_add_user_preferences.sql", "003_opt_out.sql", "004_admin_features.sql", "005_search_and_stats.sql"];
const MIGRATION_DIR = path.join(__dirname, "../../migrations");

const REQUIRED_VARS = [
  "WHATSAPP_TOKEN",
  "PHONE_NUMBER_ID",
  "VERIFY_TOKEN",
  "GROQ_API_KEY",
  "DATABASE_URL",
];

const OPTIONAL_VARS = [
  { key: "ADMIN_NUMBER",             hint: "Needed for admin commands and tip notifications" },
  { key: "WHATSAPP_APP_SECRET",      hint: "Strongly recommended for webhook signature verification" },
  { key: "GOOGLE_TRANSLATE_API_KEY", hint: "Required for Igbo/Yoruba/Hausa translation" },
  { key: "FOOTBALL_DATA_TOKEN",      hint: "Required for EPL/Champions League data" },
  { key: "API_FOOTBALL_KEY",         hint: "Required for live scores, NPFL, and fixtures" },
];

export async function validateStartup() {
  logger.info("━━━ NaijaScope Startup Validation ━━━");
  let fatal = false;

  for (const key of REQUIRED_VARS) {
    if (!process.env[key]) {
      logger.error(`[STARTUP] ❌ Missing required env var: ${key}`);
      fatal = true;
    } else {
      logger.info(`[STARTUP] ✅ ${key}`);
    }
  }

  for (const { key, hint } of OPTIONAL_VARS) {
    if (!process.env[key]) {
      logger.warn(`[STARTUP] ⚠️  ${key} not set — ${hint}`);
    } else {
      logger.info(`[STARTUP] ✅ ${key}`);
    }
  }

  if (fatal) {
    logger.error("[STARTUP] Fatal: missing required environment variables. Exiting.");
    process.exit(1);
  }

  // Verify DB connection
  try {
    await query("SELECT 1");
    logger.info("[STARTUP] ✅ Database connection verified");
  } catch (err) {
    logger.error("[STARTUP] ❌ Database connection failed:", err.message);
    process.exit(1);
  }

  // Run schema migrations in order
  for (const file of MIGRATIONS) {
    const filePath = path.join(MIGRATION_DIR, file);
    try {
      const sql = fs.readFileSync(filePath, "utf8");
      await query(sql);
      logger.info(`[STARTUP] ✅ Migration applied: ${file}`);
    } catch (err) {
      logger.warn(`[STARTUP] ⚠️  Migration skipped (${file}): ${err.message}`);
    }
  }

  // Seed keyword alerts from DB into memory
  try {
    const { getAllKeywordAlerts } = await import("../services/alertService.js");
    const rows = await getAllKeywordAlerts();
    seedKeywordAlerts(rows);
    logger.info(`[STARTUP] ✅ Loaded ${rows.length} keyword alert(s) into memory`);
  } catch (err) {
    logger.warn("[STARTUP] ⚠️  Keyword alert seed failed:", err.message);
  }

  // Seed opted-out users from DB into in-memory cache
  try {
    const { seedOptedOutUsers } = await import("../state/sessionState.js");
    const optRes = await query("SELECT whatsapp_number FROM users WHERE opted_out = TRUE");
    const numbers = optRes.rows.map(r => r.whatsapp_number);
    seedOptedOutUsers(numbers);
    logger.info(`[STARTUP] ✅ Loaded ${numbers.length} opted-out user(s) into memory`);
  } catch (err) {
    logger.warn("[STARTUP] ⚠️  Opted-out user seed failed:", err.message);
  }

  // A3: Restore breaking news mode state from DB (survives restarts)
  try {
    const { restoreBreakingState } = await import("../admin/breakingService.js");
    await restoreBreakingState();
    logger.info("[STARTUP] ✅ Breaking news state restored from DB");
  } catch (err) {
    logger.warn("[STARTUP] ⚠️  Breaking news state restore failed:", err.message);
  }

  logger.info("━━━ Startup validation complete ━━━");
}
