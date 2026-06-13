import pkg from "pg";
import { logger } from "./logger.js";
const { Pool } = pkg;

const pool = new Pool({
  connectionString:     process.env.DATABASE_URL,
  max:                  10,
  idleTimeoutMillis:    30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  logger.error("[DB] Unexpected pool error:", err.message);
});

export async function query(sql, params = []) {
  return pool.query(sql, params);
}

const ALLOWED_USER_FIELDS = [
  "language_pref", "subscription_status", "digest_enabled",
  "breaking_alerts", "favorite_team", "location_state",
  "location_lga", "resume_context", "opted_out", "opted_out_at",
];

/** Mark a user as opted out (or re-opted-in). Returns the updated row. */
export async function setOptedOut(whatsappNumber, optedOut) {
  const res = await pool.query(
    `UPDATE users
     SET opted_out = $2, opted_out_at = $3, last_seen = NOW()
     WHERE whatsapp_number = $1
     RETURNING *`,
    [whatsappNumber, optedOut, optedOut ? new Date() : null]
  );
  return res.rows[0] || null;
}

/** Returns the user row or null without creating the user. */
export async function getUser(whatsappNumber) {
  const res = await pool.query(
    "SELECT * FROM users WHERE whatsapp_number = $1",
    [whatsappNumber]
  );
  return res.rows[0] || null;
}

/**
 * Upsert user: create if new, always touch last_seen, optionally update fields.
 * Returns the updated row. Single query via ON CONFLICT DO UPDATE.
 */
export async function upsertUser(whatsappNumber, fields = {}) {
  const filtered = Object.fromEntries(
    Object.entries(fields).filter(([k]) => ALLOWED_USER_FIELDS.includes(k))
  );
  const fieldKeys   = Object.keys(filtered);
  const fieldValues = Object.values(filtered);

  let conflictSets = "last_seen = NOW()";
  if (fieldKeys.length > 0) {
    const sets = fieldKeys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    conflictSets = `${sets}, last_seen = NOW()`;
  }

  const res = await pool.query(
    `INSERT INTO users (whatsapp_number, last_seen)
     VALUES ($1, NOW())
     ON CONFLICT (whatsapp_number) DO UPDATE SET ${conflictSets}
     RETURNING *`,
    [whatsappNumber, ...fieldValues]
  );
  return res.rows[0];
}

export default pool;
