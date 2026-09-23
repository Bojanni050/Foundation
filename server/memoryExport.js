const MEMORY_EXPORT_VERSION = 1;

// Explicit columns are a privacy and portability boundary. Embeddings and
// object search chunks are derived data and intentionally omitted: they are
// large, model-specific, and can be rebuilt from the archived source objects.
const EXPORT_QUERIES = {
  hypotheses: `SELECT id, hypothese, verificatie_criteria, bevestigings_criteria,
    afwijzings_criteria, status, confirmed_at, rejected_at, verwerp_reden, created_at
    FROM hypothesis ORDER BY created_at ASC`,
  episodes: `SELECT id, bron_object_id, bronsoort, fragment, spreker, observed_at,
    bron_referentie, conversation_identity, source_type, extraction_confidence,
    context_window, observation_hash, captured_at
    FROM episode ORDER BY captured_at ASC`,
  evidence: `SELECT id, hypothesis_id, episode_id, richting, created_at
    FROM evidence ORDER BY created_at ASC`,
  knowledgeGaps: `SELECT id, onderwerp, status, hypothesis_id, resolved_at, created_at
    FROM knowledge_gap ORDER BY created_at ASC`,
  knowledge: `SELECT id, categorie, kenmerk, soort, gevoelig, zekerheid, status,
    bron_object_ids, vervangen_door, verwerp_reden, verwerp_bron, voorganger_id,
    valid_from, valid_to, temporal_text, created_at, laatst_versterkt_op
    FROM persona_kenmerk ORDER BY created_at ASC`,
  knowledgeUsage: `SELECT id, kenmerk_id, gebruikt_in_object_id, context, gebruikt_op
    FROM persona_kenmerk_gebruik ORDER BY gebruikt_op ASC`,
  personaSettings: `SELECT id, confidence_threshold, promotie_min_bronnen,
    skepticism, literalism, empathy, updated_at FROM persona_instelling ORDER BY updated_at ASC`,
  pulseCache: `SELECT id, items, ai_used, generated_at
    FROM persona_pulse_cache ORDER BY generated_at ASC`,
};

async function buildMemoryExport(pool) {
  const tables = {};
  for (const [name, query] of Object.entries(EXPORT_QUERIES)) {
    const { rows } = await pool.query(query);
    tables[name] = rows;
  }
  return {
    format: "foundation-chronicle-memory",
    version: MEMORY_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    derivedDataExcluded: ["object_chunk", "object_embedding", "embedding vectors"],
    tables,
  };
}

module.exports = { MEMORY_EXPORT_VERSION, EXPORT_QUERIES, buildMemoryExport };
