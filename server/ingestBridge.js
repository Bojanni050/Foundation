// De brug tussen de Ingestie Gateway en het memory-proces: elke nog niet
// verwerkte rij in ingest_object (de Gateway-inbox, routes/ingest.js) wordt
// hier exact één keer als episode bevroren — via createOrReuseEpisode, dus
// via hetzelfde idempotente pad als de HTTP-route (ON CONFLICT op
// observation_hash).
//
// Epistemiek (Manifest §5): een episode is zélf een bevroren observatie. De
// brug leidt niets af, promoot niets en raakt de statusmarkering niet aan —
// die blijft server-owned. turns/attachments blijven in ingest_object (source
// of truth); alleen content wordt verbatim als fragment bevroren, met
// bronverwijzing via bronObjectId "ingest:<uuid>". Per-turn-segmentatie van
// chats is een bewuste latere verfijning; de bevroren episode per object
// verliest niets (de volledige turns blijven in de bronrij staan).
//
// Verwerkingsmarker: memory_processed_at (migratie 0020). NULL = nog niet
// verwerkt. De ingest-upsert reset de kolom zodra dezelfde conversatie
// gegroeid opnieuw binnenkomt, zodat de nieuwe versie óók een episode
// oplevert (de eerdere episode blijft als onveranderlijke historie bestaan).
//
// Draait als achtergrondjob in het memory-proces (jobs.js start de
// scheduler) — het capture-proces (server/index.js) schrijft nooit episodes.

const { pool } = require("./db");
const { createOrReuseEpisode } = require("./routes/memory");
const { mapIngestRowToEpisodeInput } = require("./ingestBridgeMapping");

const BATCH_LIMIT = 50;

async function runIngestBridge() {
  let rows;
  try {
    const result = await pool.query(
      "SELECT * FROM ingest_object WHERE memory_processed_at IS NULL ORDER BY ingested_at ASC LIMIT $1",
      [BATCH_LIMIT],
    );
    rows = result.rows;
  } catch (err) {
    console.error("[IngestBridge] poll failed:", err.message);
    return;
  }

  if (rows.length === 0) return;

  let processed = 0;
  for (const row of rows) {
    try {
      const input = mapIngestRowToEpisodeInput(row);
      const result = await createOrReuseEpisode(input);
      await pool.query(
        "UPDATE ingest_object SET memory_processed_at = now() WHERE id = $1",
        [row.id],
      );
      processed++;
      console.log(
        `[IngestBridge] ${result.reused ? "reused" : "froze"} episode for ingest_object ${row.id}`
      );
    } catch (err) {
      // Niet markeren — de volgende run probeert opnieuw. Een onbekend
      // object_type blijft hierdoor luid mislukken (typeward) in plaats van
      // stilletjes te verdwijnen.
      console.error(
        `[IngestBridge] ingest_object ${row.id} failed (will retry):`,
        err.message
      );
    }
  }
  console.log(`[IngestBridge] processed ${processed}/${rows.length} ingest object(s)`);
}

module.exports = { runIngestBridge };
