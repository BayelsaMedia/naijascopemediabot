import { query } from "../utils/db.js";
import { logger } from "../utils/logger.js";

export async function saveArticle(whatsappNumber, article) {
  try {
    await query(
      `INSERT INTO saved_articles (whatsapp_number, article_id, article_title, article_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [whatsappNumber, article.id || article.link, article.title, article.link]
    );
    return true;
  } catch (err) {
    logger.error("saveArticle error:", err.message);
    return false;
  }
}

export async function getSavedArticles(whatsappNumber) {
  try {
    const res = await query(
      "SELECT * FROM saved_articles WHERE whatsapp_number = $1 ORDER BY saved_at DESC LIMIT 10",
      [whatsappNumber]
    );
    return res.rows;
  } catch (err) {
    logger.error("getSavedArticles error:", err.message);
    return [];
  }
}

export async function deleteSavedArticle(whatsappNumber, articleId) {
  try {
    await query(
      "DELETE FROM saved_articles WHERE whatsapp_number = $1 AND article_id = $2",
      [whatsappNumber, articleId]
    );
    return true;
  } catch (err) {
    logger.error("deleteSavedArticle error:", err.message);
    return false;
  }
}
