// Upload van een compleet bronbestand (het originele exportbestand waaruit
// chats zijn geparseerd) — het "ultieme bewijs" dat Foundation als eigenaar
// bewaart en Chronicle byte-for-byte spiegelt. Zie
// Gaia-Documentation/capture-chronicle.md.
//
// Body = de rauwe bytes (express.raw, geen JSON). Identiteit = sha256; een
// herlevering van hetzelfde bestand is idempotent. De bytes gaan in de
// blob-store (server/blobStore.js), de metadata in source_blob, en er wordt
// één `document`-observatie in ingest_object geregistreerd zodat het bestand
// als episode zichtbaar is zonder de hele blob als tekst te behandelen.
//
// Bewust GEEN inhoudelijke interpretatie: Foundation registreert alleen wat
// het krijgt. Het parsen van chats gebeurt aan de capture-kant (Chronicle).

const express = require("express");
const path = require("path");
const { pool } = require("../db");
const { requireAuth } = require("../auth");
const { contentHash } = require("../contentHash");
const { createBlobStore } = require("../blobStore");

const router = express.Router();
const blobStore = createBlobStore();

// Ruim boven de attachment-limiet (25MB): exportbestanden kunnen honderden
// MB's zijn. Afgestemd op een ruime but bounded body; de VPS regelt de rest.
const MAX_SIZE = 512 * 1024 * 1024;

router.post("/", requireAuth, express.raw({ type: () => true, limit: "512mb" }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: "empty body" });
  }
  if (req.body.length > MAX_SIZE) {
    return res.status(413).json({ error: "file too large (512MB max)" });
  }

  const rawFilename = req.get("X-Source-Filename") || "export";
  let filename;
  try {
    filename = decodeURIComponent(rawFilename);
  } catch {
    filename = rawFilename;
  }
  const mimeType = req.get("Content-Type") || "application/octet-stream";

  let blob;
  try {
    blob = blobStore.put(req.body, { filename: path.basename(filename), mimeType });
  } catch (err) {
    return res.status(500).json({ error: "blob store failed", detail: err.message });
  }

  // De document-observatie: titel = bestandsnaam, content = een korte,
  // niet-interpreterende beschrijving (de bytes zelf leven in de blob — een
  // 300MB blob hoort niet in de content-kolom). content_hash/identiteit zijn
  // server-side; het bestand is herkenbaar aan zijn sha256.
  const title = path.basename(filename) || "source file";
  const summary = `Source file "${title}" (${blob.size} bytes, ${blob.mimeType}, sha256 ${blob.hash})`;
  const hash = contentHash(summary);

  try {
    // Idempotent op de blob-identiteit: een al geregistreerde blob levert geen
    // tweede observatie op — de eerste blijft de bron van waarheid.
    const existing = await pool.query(
      "SELECT ingest_object_id FROM source_blob WHERE hash = $1",
      [blob.hash],
    );
    if (existing.rows[0]) {
      return res.status(200).json({
        hash: blob.hash,
        size: blob.size,
        filename: path.basename(filename) || null,
        mimeType: blob.mimeType,
        reused: true,
        ingestObjectId: existing.rows[0].ingest_object_id,
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO ingest_object (object_type, source, title, content, url, content_hash, status)
       VALUES ('document', $1, $2, $3, $4, $5, 'observation')
       RETURNING id`,
      ["chronicle-capture", title, summary, `blob://${blob.hash}`, hash],
    );
    const ingestObjectId = rows[0].id;

    await pool.query(
      `INSERT INTO source_blob (hash, ingest_object_id, size, filename, mime_type)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (hash) DO NOTHING`,
      [blob.hash, ingestObjectId, blob.size, path.basename(filename) || null, blob.mimeType],
    );

    return res.status(blob.reused ? 200 : 201).json({
      hash: blob.hash,
      size: blob.size,
      filename: path.basename(filename) || null,
      mimeType: blob.mimeType,
      reused: blob.reused,
      ingestObjectId,
    });
  } catch (err) {
    console.error("[sourceFiles] register failed:", err.message);
    return res.status(500).json({ error: "register failed", detail: err.message });
  }
});

// Read-only metadata (geen bytes) voor verificatie van de kopie.
router.get("/:hash", requireAuth, async (req, res) => {
  const meta = blobStore.getMeta(req.params.hash);
  if (!meta) return res.status(404).json({ error: "blob not found" });
  const { rows } = await pool.query(
    "SELECT ingest_object_id, size, filename, mime_type, created_at FROM source_blob WHERE hash = $1",
    [req.params.hash],
  );
  res.json({ ...meta, registered: rows[0] || null });
});

module.exports = router;
