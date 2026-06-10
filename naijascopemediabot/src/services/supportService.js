import { query } from "../utils/db.js";
import { sendText } from "./whatsappService.js";
import { logger } from "../utils/logger.js";

const HANDOFF_TRIGGERS = ["human", "agent", "talk to journalist", "speak to someone", "editor", "journalist", "talk to a journalist"];

export function isHandoffRequest(text) {
  const t = text.toLowerCase().trim();
  return HANDOFF_TRIGGERS.some(trigger => t.includes(trigger));
}

export function generateReference() {
  const year = new Date().getFullYear();
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `NS-${year}-${rand}`;
}

export async function createSupportTicket(whatsappNumber, issue) {
  const ref = generateReference();
  try {
    await query(
      `INSERT INTO support_tickets (reference_code, whatsapp_number, issue)
       VALUES ($1, $2, $3)`,
      [ref, whatsappNumber, issue]
    );
    logger.info(`[TICKET] Created ${ref} for ${whatsappNumber}`);
    return ref;
  } catch (err) {
    logger.error("createSupportTicket error:", err.message);
    return null;
  }
}

export async function transferToHuman(whatsappNumber, issue) {
  const ref = await createSupportTicket(whatsappNumber, issue);
  if (!ref) {
    await sendText(whatsappNumber, "Sorry, couldn't connect you right now. Please try again shortly.");
    return null;
  }

  await sendText(
    whatsappNumber,
    `🎙️ Connecting you to the NaijaScope newsroom...\n\nYour reference: *${ref}*\n\nA journalist will respond shortly. Keep this reference number safe.\n\n_The bot will pause during your session. Reply "menu" to return to the bot anytime._`
  );

  if (process.env.ADMIN_NUMBER) {
    await sendText(
      process.env.ADMIN_NUMBER,
      `🔔 Human handoff requested\nRef: ${ref}\nFrom: ${whatsappNumber}\nIssue: ${issue}`
    );
  }

  return ref;
}

export async function getOpenTicket(whatsappNumber) {
  const res = await query(
    "SELECT * FROM support_tickets WHERE whatsapp_number = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1",
    [whatsappNumber]
  );
  return res.rows[0] || null;
}

export async function closeTicket(referenceCode) {
  await query(
    "UPDATE support_tickets SET status = 'closed', closed_at = NOW() WHERE reference_code = $1",
    [referenceCode]
  );
}
