import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
});

export async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

/** Returns the user row or null — does NOT create the user. */
export async function getUser(whatsappNumber) {
  const res = await query(
    "SELECT * FROM users WHERE whatsapp_number = $1",
    [whatsappNumber]
  );
  return res.rows[0] || null;
}

/**
 * Create user if not exists, then optionally update fields and touch last_seen.
 * Returns the updated user row.
 */
export async function upsertUser(whatsappNumber, fields = {}) {
  await query(
    `INSERT INTO users (whatsapp_number, last_seen)
     VALUES ($1, NOW())
     ON CONFLICT (whatsapp_number) DO NOTHING`,
    [whatsappNumber]
  );

  if (Object.keys(fields).length > 0) {
    const allowed = [
      "language_pref", "subscription_status", "digest_enabled",
      "breaking_alerts", "favorite_team", "location_state",
      "location_lga", "last_seen", "resume_context",
    ];
    const filtered = Object.fromEntries(
      Object.entries(fields).filter(([k]) => allowed.includes(k))
    );
    if (Object.keys(filtered).length > 0) {
      const sets = Object.keys(filtered).map((k, i) => `${k} = $${i + 2}`).join(", ");
      await query(
        `UPDATE users SET ${sets}, last_seen = NOW() WHERE whatsapp_number = $1`,
        [whatsappNumber, ...Object.values(filtered)]
      );
    }
  } else {
    await query(
      "UPDATE users SET last_seen = NOW() WHERE whatsapp_number = $1",
      [whatsappNumber]
    );
  }

  return getUser(whatsappNumber);
}

export default pool;
