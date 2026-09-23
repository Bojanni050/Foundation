// Ingestie Gateway — de server-side ingest-route. Elke capture-bron komt hier
// binnen via een typeward entry-point (zie ../ingestPolicy.js):
//
//   POST /api/ingest/chat      — AI-chats (extension, bulk-import, ...)
//   POST /api/ingest/capture   — desktop-capture (Capture RS)
//   POST /api/ingest/document  — expliciet gedeelde documenten
//   POST /api/ingest/diary     — audio/video-log (Diary)
//
// Epistemiek zit hier bewust NIET: alles wat binnenkomt wordt als
// `observation` weggeschreven (status is server-owned, zie ingestPolicy).
// provider_conversation_id wordt hier afgeleid (providerConversationId.js)
// en dient als idempotieits-identiteit: dezelfde conversatie die opnieuw
// binnenkomt (gegroeid of via een tweede kanaal) updatet dezelfde rij via
// ON CONFLICT DO UPDATE in plaats van te dupliceren. content_hash komt uit
// contentHash.js — zelfde algoritme als frontend/inbox, portable.
//
// Geen ruisfilter in Foundation: de capture-kant filtert vóór indiening; hier
// wordt geregistreerd wat de officiële pijp bereikt.

const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../auth");
const { contentHash } = require("../contentHash");
const { deriveProviderConversationId } = require("../providerConversationId");
const { normalizeIngestRecord } = require("../ingestPolicy");

const router = express.Router();

const UPSERT_SQL = `
  INSERT INTO ingest_object (
    object_type, source, title, content, source_provider, url,
    tags, turns, attachments, occurred_at, content_hash,
    provider_conversation_id, status
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, 'observation')
  ON CONFLICT (provider_conversation_id) DO UPDATE SET
    title = EXCLUDED.title,
    content = EXCLUDED.content,
    source_provider = EXCLUDED.source_provider,
    url = EXCLUDED.url,
    tags = EXCLUDED.tags,
    turns = EXCLUDED.turns,
    attachments = EXCLUDED.attachments,
    occurred_at = EXCLUDED.occurred_at,
    content_hash = EXCLUDED.content_hash,
    updated_at = now()
  RETURNING id, provider_conversation_id, (xmax = 0) AS inserted_new, ingested_at, updated_at
`;

async function acceptIngest(objectType, req, res) {
  const verdict = normalizeIngestRecord(objectType, req.body);
  if (!verdict.ok) {
    // 422: het verzoek is wel JSON, maar voldoet niet aan het contract.
    return res.status(422).json({ error: "invalid ingest payload", details: verdict.errors, objectType });
  }
  const r = verdict.record;
  const providerConversationId = deriveProviderConversationId(r.sourceProvider, r.url);
  const hash = contentHash(r.content);

  try {
    const { rows } = await pool.query(UPSERT_SQL, [
      objectType,
      r.source,
      r.title ?? null,
      r.content,
      r.sourceProvider ?? null,
      r.url ?? null,
      Array.isArray(r.tags) ? r.tags : [],
      r.turns !== undefined ? JSON.stringify(r.turns) : null,
      r.attachments !== undefined ? JSON.stringify(r.attachments) : null,
      r.occurredAt ?? null,
      hash,
      providerConversationId,
    ]);
    const row = rows[0];
    return res.status(row.inserted_new ? 201 : 200).json({
      success: true,
      id: row.id,
      objectType,
      status: "observation", // nog eens expliciet terug: de client leert dat dit niet onderhandelbaar is
      providerConversationId: row.provider_conversation_id,
      insertedNew: row.inserted_new,
      ingestedAt: row.ingested_at,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    console.error("[ingest] failed:", objectType, err.message);
    return res.status(500).json({ error: "ingest failed", detail: err.message });
  }
}

router.post("/chat", requireAuth, (req, res) => acceptIngest("chat", req, res));
router.post("/capture", requireAuth, (req, res) => acceptIngest("capture", req, res));
router.post("/document", requireAuth, (req, res) => acceptIngest("document", req, res));
router.post("/diary", requireAuth, (req, res) => acceptIngest("diary", req, res));

// Diagnostiek/observatie: laatste 50 binnenkomende objecten (read-only, geen
// epistemiek — alleen wat er al geregistreerd staat).
router.get("/recent", requireAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, object_type, source, title, provider_conversation_id, status, ingested_at, updated_at
       FROM ingest_object ORDER BY ingested_at DESC LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "query failed", detail: err.message });
  }
});

module.exports = router;
