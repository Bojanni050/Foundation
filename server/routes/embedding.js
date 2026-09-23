const express = require("express");
const { pool } = require("../db");
const { embed } = require("../embedding");

const router = express.Router();

function roleLabel(role) {
  return role === "assistant" ? "Assistant" : "User";
}

// POST /api/objects/:objectId/embed
// Called after any object is created/re-imported that's worth making
// searchable: chat objects (extension inbox or manual paste/upload, which
// have turns) as well as single-blob objects like Screenpipe extractions or
// plain notes (no turns — the whole content becomes one chunk). Best-effort,
// same graceful-fallback philosophy as persona_kenmerk: a failed embedding
// never blocks the object itself, which already lives safely in IndexedDB
// by the time this runs.
//
// Body: { turns?: [{ role: "user"|"assistant", text: string }], content: string }
//
// Chunking is one chunk per turn when turns are present, with the role baked
// into the chunk's own content ("Assistant: ...") rather than a dedicated
// column — object_chunk is a generic per-object content-search table, not
// chat-specific, so "who said this" stays a parsing-time detail instead of a
// schema concern. Without turns, the whole content becomes a single chunk.
router.post("/:objectId/embed", async (req, res) => {
  const { objectId } = req.params;
  const { turns, content } = req.body || {};
  const validTurns = Array.isArray(turns) ? turns.filter((t) => t && t.text && t.text.trim()) : [];

  // Chunk source: turn-per-chunk if we have structured turns, otherwise the
  // whole flattened content as a single chunk (Screenpipe items, plain notes).
  const chunkSources = validTurns.length
    ? validTurns.map((t) => `${roleLabel(t.role)}: ${t.text}`)
    : content && content.trim()
    ? [content.trim()]
    : [];

  const client = await pool.connect();
  let chunksEmbedded = 0;
  let objectEmbedded = false;

  try {
    await client.query("BEGIN");

    // Re-embed is idempotent: clear previous chunks for this object first
    // (covers re-import / re-processing the same object).
    await client.query("DELETE FROM object_chunk WHERE object_id = $1", [objectId]);

    for (let i = 0; i < chunkSources.length; i++) {
      const chunkContent = chunkSources[i];
      let embeddingLiteral = null;
      try {
        embeddingLiteral = `[${(await embed(chunkContent)).join(",")}]`;
      } catch (err) {
        console.error(`[embed] chunk embedding failed (object ${objectId}, chunk ${i}):`, err.message);
      }
      await client.query(
        `INSERT INTO object_chunk (object_id, content, order_index, embedding)
         VALUES ($1, $2, $3, $4)`,
        [objectId, chunkContent, i, embeddingLiteral]
      );
      if (embeddingLiteral) chunksEmbedded++;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[embed] chunk transaction failed (object ${objectId}):`, err.message);
  } finally {
    client.release();
  }

  // Object-level embedding: whole-object search, separate from the
  // per-chunk transaction above so one failing doesn't block the other.
  try {
    const summarySource = (content || chunkSources.join("\n\n")).slice(0, 8000);
    if (summarySource.trim()) {
      const embeddingLiteral = `[${(await embed(summarySource)).join(",")}]`;
      await pool.query(
        `INSERT INTO object_embedding (object_id, embedding, created_at)
         VALUES ($1, $2, now())
         ON CONFLICT (object_id) DO UPDATE SET embedding = EXCLUDED.embedding, created_at = now()`,
        [objectId, embeddingLiteral]
      );
      objectEmbedded = true;
    }
  } catch (err) {
    console.error(`[embed] object-level embedding failed (object ${objectId}):`, err.message);
  }

  res.status(200).json({ success: true, chunksEmbedded, totalChunks: chunkSources.length, objectEmbedded });
});

module.exports = router;
