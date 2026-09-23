// Ingestie/capture-log-API voor het dashboard op /ui (public/index.html).
// Alleen lezen: deze route toont wat er binnenkomt en of de brug het al
// heeft verwerkt — hij beïnvloedt nooit de verwerking zelf.
// GET /api/ingest-logs          — recente ingest_object-rijen + inbox-items
// GET /api/ingest-logs/:id      — volledige rij + de episodes die eruit zijn
//                                 bevroren (bron_object_id = ingest:<uuid>)
const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../auth");
const { readInbox } = require("../inboxStore");

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const { rows } = await pool.query(
      `SELECT id, object_type, source, title, source_provider, url, tags,
              provider_conversation_id, status, ingested_at, updated_at,
              occurred_at, memory_processed_at,
              (turns IS NOT NULL) AS has_turns,
              (attachments IS NOT NULL) AS has_attachments,
              length(content) AS content_length
       FROM ingest_object
       ORDER BY ingested_at DESC
       LIMIT $1`,
      [limit],
    );
    // De legacy-inbox (file-based, /api/objects/import) hoort er ook bij:
    // het is nog steeds een manier waarop data Foundation in gepompt wordt.
    res.json({ objects: rows, inbox: readInbox() });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM ingest_object WHERE id = $1",
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: "ingest_object not found" });
    const { rows: episodes } = await pool.query(
      `SELECT id, bron_object_id, source_type, spreker, fragment,
              observed_at, captured_at, observation_hash
       FROM episode WHERE bron_object_id = $1
       ORDER BY captured_at ASC`,
      ["ingest:" + rows[0].id],
    );
    res.json({ object: rows[0], episodes });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
