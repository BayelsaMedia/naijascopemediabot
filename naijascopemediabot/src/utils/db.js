import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

export async function getUser(whatsappNumber) {
  const res = await query(
    "SELECT * FROM users WHERE whatsapp_number = $1",
    [whatsappNumber]
  );
  return res.rows[0] || null;
}

export async function upsertUser(whatsappNumber, fields = {}) {
  const existing = await getUser(whatsappNumber);
  if (!existing) {
    await query(
      "INSERT INTO users (whatsapp_number, last_seen) VALUES ($1, NOW())",
      [whatsappNumber]
    );
  }
  if (Object.keys(fields).length > 0) {
    const sets = Object.keys(fields).map((k, i) => `${k} = $${i + 2}`).join(", ");
    const values = Object.values(fields);
    await query(
      `UPDATE users SET ${sets}, last_seen = NOW() WHERE whatsapp_number = $1`,
      [whatsappNumber, ...values]
    );
  } else {
    await query("UPDATE users SET last_seen = NOW() WHERE whatsapp_number = $1", [whatsappNumber]);
  }
  return await getUser(whatsappNumber);
}

export default pool;
