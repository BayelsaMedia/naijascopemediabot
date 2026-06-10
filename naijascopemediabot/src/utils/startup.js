import { logger } from "./logger.js";
import { query } from "./db.js";

const REQUIRED_VARS = [
  "WHATSAPP_TOKEN",
  "PHONE_NUMBER_ID",
  "VERIFY_TOKEN",
  "GROQ_API_KEY",
  "DATABASE_URL",
];

const OPTIONAL_VARS = [
  { key: "ADMIN_NUMBER", hint: "Needed for admin commands and tip notifications" },
  { key: "WHATSAPP_APP_SECRET", hint: "Strongly recommended for webhook signature verification" },
  { key: "GOOGLE_TRANSLATE_API_KEY", hint: "Required for Igbo/Yoruba/Hausa translation" },
  { key: "FOOTBALL_DATA_TOKEN", hint: "Required for EPL/Champions League data" },
  { key: "API_FOOTBALL_KEY", hint: "Required for live scores, NPFL, fixtures" },
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
      logger.warn(`[STARTUP] ⚠️  Optional ${key} not set — ${hint}`);
    } else {
      logger.info(`[STARTUP] ✅ ${key}`);
    }
  }

  if (fatal) {
    logger.error("[STARTUP] Fatal: missing required environment variables. Exiting.");
    process.exit(1);
  }

  // Verify database connection
  try {
    await query("SELECT 1");
    logger.info("[STARTUP] ✅ Database connection verified");
  } catch (err) {
    logger.error("[STARTUP] ❌ Database connection failed:", err.message);
    process.exit(1);
  }

  logger.info("━━━ Startup validation complete ━━━");
}
