// De reflectie-pijp: mens-bevestigde feiten (fact, met provenance via de
// bevestigende hypothese) exact één keer naar Hindsight's bank gestuurd.
//
// Epistemiek (Manifest §5, zelfde redenering als ingestBridge): Foundation
// bevriest en promoot; Hindsight herinnert. Wat er hier overstroomt is
//uitsluitend mens-bevestigd werk — geen open hypotheses, geen ruwe
// episodes (Hindsight's eigen extractie doet immers al het hare met ruw
// materiaal elders; dubbele extractie van dezelfde observaties maakt de
// bank vetter zonder ooit een menselijke promotie te representeren).
//
// Watermerk-patroon (consolidation_progress, migratie 0021): eigen rij
// per pijp met last_fact_created_at. Het watermerk verzet pas nadat de
// batch volledig is geretained — faalt Hindsight halverwege, dan pakt
// de volgende run dezelfde feiten opnieuw (Hindsight's retain is
// idempotent genoeg: een tweede push van hetzelfde feit is een extra
// memory met identieke inhoud, geen corruptie — bewust steeds vooruit
// in plaats van een dedup-akkoord met een externe dienst). Het watermerk
// schuift naar de laatste VERWERKTE fact, nooit voorbij de batch: een burst
// (massale confirms na een bulk-import) laat de rest van het venster staan
// voor de volgende run in plaats van hem stilzwijgend te verspringen.
//
// Draait als achtergrondjob in het memory-proces (jobs.js), niet in het
// capture-proces — zelfde isolatie-redenering als de consolidator.
const { pool: dbPool } = require("./db");
const { createHindsightClient } = require("./hindsightClient");

const CHECKPOINT_ID = "00000000-0000-0000-0000-000000000001";
const BATCH_LIMIT = 25;

function buildFactItem(fact, hypothesis) {
  // Rows arrive straight from `SELECT f.*` → snake_case. Accept camelCase
  // too (same dual-shape tolerance as epistemicPolicy.buildFactFromHypothesis)
  // so the function works with injected/test rows as well — a purely
  // camelCase implementation looked fine in tests and silently sent
  // timestamp "unset" and empty provenance to Hindsight in production.
  const created = fact.created_at ?? fact.createdAt;
  const validFrom = fact.valid_from ?? fact.validFrom;
  const validTo = fact.valid_to ?? fact.validTo;
  const temporalText = fact.temporal_text ?? fact.temporalText;
  const supersedes = fact.supersedes_fact_id ?? fact.supersedesFactId;
  return {
    content: fact.inhoud,
    context: hypothesis ? (hypothesis.hypothese ?? null) : null,
    timestamp: created ? created.toISOString() : "unset",
    documentId: fact.id,
    tags: ["foundation:fact"],
    metadata: {
      foundation_fact_id: fact.id,
      foundation_hypothesis_id: fact.hypothesis_id ?? fact.hypothesisId ?? "",
      ...(validFrom ? { valid_from: validFrom.toISOString() } : {}),
      ...(validTo ? { valid_to: validTo.toISOString() } : {}),
      ...(temporalText ? { temporal_text: temporalText } : {}),
      ...(supersedes ? { supersedes_fact_id: supersedes } : {}),
    },
  };
}

async function runHindsightSync({ client, pool: poolArg, now = () => new Date() } = {}) {
  if (!client) return;
  const pool = poolArg || dbPool;

  const batchUpperBound = now();
  let facts = [];
  try {
    const { rows: cpRows } = await pool.query(
      "SELECT last_fact_created_at FROM hindsight_progress WHERE id = $1",
      [CHECKPOINT_ID]
    );
    const lastFactAt = cpRows[0] ? cpRows[0].last_fact_created_at : null;
    const { rows } = await pool.query(
      `SELECT f.*, h.hypothese
       FROM fact f
       LEFT JOIN hypothesis h ON h.id = f.hypothesis_id
       WHERE f.created_at > COALESCE($1, to_timestamp(0))
         AND f.created_at <= $2
       ORDER BY f.created_at ASC
       LIMIT $3`,
      [lastFactAt, batchUpperBound, BATCH_LIMIT]
    );
    facts = rows;
  } catch (err) {
    console.error("[HindsightSync] fact-query mislukt:", err.message);
    return;
  }
  if (facts.length === 0) return;

  let retained = 0;
  for (const fact of facts) {
    try {
      await client.retain(buildFactItem(fact, { hypothese: fact.hypothese }));
      retained++;
    } catch (err) {
      // Watermerk niet verzetten — de volgende run haalt dit feit opnieuw
      // op, samen met de rest van de batch. Luid mislukken, nooit stilletjes
      // een feit overslaan.
      console.error(
        `[HindsightSync] retain van fact ${fact.id} mislukt (volgende run probeert opnieuw):`,
        err.message
      );
      return;
    }
  }

  try {
    // Burst-safe watermerk: schuift naar de TIJDSTIP VAN DE LAATST VERWERKTE
    // fact, nooit naar batchUpperBound. Een voller batch (BATCH_LIMIT bereikt,
    // bijv. massale confirms na een bulk-import) laat de rest van het venster
    // onaangeroerd — de volgende run pakt die op dezelfde plek op. Vóór deze
    // regel sloop de pijp bij een burst stilzwijgend over niet-verwerkte
    // feiten heen: hun created_at < upperBound viel voort buiten het venster.
    const last = facts[facts.length - 1];
    const watermarkAt = last.created_at ?? last.createdAt ?? batchUpperBound;
    await pool.query(
      `INSERT INTO hindsight_progress (id, last_fact_created_at, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE
       SET last_fact_created_at = EXCLUDED.last_fact_created_at, updated_at = now()`,
      [CHECKPOINT_ID, watermarkAt]
    );
    console.log(`[HindsightSync] ${retained}/${facts.length} fact(en) naar Hindsight gestuurd`);
  } catch (err) {
    console.error("[HindsightSync] watermerk-bijwerking mislukt:", err.message);
  }
}

// Fabricage volgens de .env-configuratie; null als de pijp niet geconfigureerd
// is — startBackgroundJobs start hem dan gewoon niet (geen fout elke run).
function hindsightClientFromEnv() {
  const baseUrl = process.env.HINDSIGHT_URL;
  const bankId = process.env.HINDSIGHT_BANK_ID;
  if (!baseUrl || !bankId) return null;
  try {
    return createHindsightClient({ baseUrl, bankId });
  } catch (err) {
    console.error("[HindsightSync] configuratie ongeldig, pijp blijft uit:", err.message);
    return null;
  }
}

module.exports = { runHindsightSync, hindsightClientFromEnv, buildFactItem, CHECKPOINT_ID };
