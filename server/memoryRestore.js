const { MEMORY_EXPORT_VERSION } = require("./memoryExport");

const TABLE_NAMES = [
  "hypotheses",
  "episodes",
  "evidence",
  "knowledgeGaps",
  "knowledge",
  "knowledgeUsage",
  "personaSettings",
  "pulseCache",
];

function validateMemoryImport(memory) {
  if (!memory || memory.format !== "foundation-chronicle-memory") {
    throw new TypeError("Not a Chronicle memory export");
  }
  if (memory.version !== MEMORY_EXPORT_VERSION) {
    throw new TypeError(`Unsupported memory export version: ${memory.version}`);
  }
  if (!memory.tables || TABLE_NAMES.some((name) => !Array.isArray(memory.tables[name]))) {
    throw new TypeError("Memory export is missing required tables");
  }
  return memory;
}

async function upsertHypotheses(client, rows) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO hypothesis
         (id, hypothese, verificatie_criteria, bevestigings_criteria, afwijzings_criteria,
          status, confirmed_at, rejected_at, verwerp_reden, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         hypothese = EXCLUDED.hypothese,
         verificatie_criteria = EXCLUDED.verificatie_criteria,
         bevestigings_criteria = EXCLUDED.bevestigings_criteria,
         afwijzings_criteria = EXCLUDED.afwijzings_criteria,
         status = EXCLUDED.status,
         confirmed_at = EXCLUDED.confirmed_at,
         rejected_at = EXCLUDED.rejected_at,
         verwerp_reden = EXCLUDED.verwerp_reden`,
      [row.id, row.hypothese, row.verificatie_criteria, row.bevestigings_criteria,
        row.afwijzings_criteria, row.status, row.confirmed_at, row.rejected_at,
        row.verwerp_reden, row.created_at],
    );
  }
}

async function restoreEpisodes(client, rows) {
  const idMap = new Map();
  let reused = 0;
  for (const row of rows) {
    const existing = await client.query(
      "SELECT id, observation_hash FROM episode WHERE id = $1 OR observation_hash = $2",
      [row.id, row.observation_hash],
    );
    const sameObservation = existing.rows.find((candidate) => candidate.observation_hash === row.observation_hash);
    if (sameObservation) {
      idMap.set(row.id, sameObservation.id);
      reused += 1;
      continue;
    }
    if (existing.rows.length) {
      throw new Error(`Episode id conflict: ${row.id}`);
    }
    await client.query(
      `INSERT INTO episode
         (id, bron_object_id, bronsoort, fragment, spreker, observed_at, bron_referentie,
          conversation_identity, source_type, extraction_confidence, context_window,
          observation_hash, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [row.id, row.bron_object_id, row.bronsoort, row.fragment, row.spreker,
        row.observed_at, row.bron_referentie, row.conversation_identity, row.source_type,
        row.extraction_confidence, row.context_window, row.observation_hash, row.captured_at],
    );
    idMap.set(row.id, row.id);
  }
  return { idMap, reused };
}

async function restoreEvidence(client, rows, episodeIdMap) {
  for (const row of rows) {
    const episodeId = episodeIdMap.get(row.episode_id) || row.episode_id;
    const existing = await client.query(
      `SELECT id, hypothesis_id, episode_id
       FROM evidence WHERE id = $1 OR (hypothesis_id = $2 AND episode_id = $3)`,
      [row.id, row.hypothesis_id, episodeId],
    );
    const sameLink = existing.rows.find(
      (candidate) => candidate.hypothesis_id === row.hypothesis_id && candidate.episode_id === episodeId,
    );
    if (sameLink) {
      await client.query("UPDATE evidence SET richting = $1 WHERE id = $2", [row.richting, sameLink.id]);
      continue;
    }
    if (existing.rows.length) throw new Error(`Evidence id conflict: ${row.id}`);
    await client.query(
      `INSERT INTO evidence (id, hypothesis_id, episode_id, richting, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [row.id, row.hypothesis_id, episodeId, row.richting, row.created_at],
    );
  }
}

async function upsertKnowledgeGaps(client, rows) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO knowledge_gap (id, onderwerp, status, hypothesis_id, resolved_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET onderwerp = EXCLUDED.onderwerp,
         status = EXCLUDED.status, hypothesis_id = EXCLUDED.hypothesis_id,
         resolved_at = EXCLUDED.resolved_at`,
      [row.id, row.onderwerp, row.status, row.hypothesis_id, row.resolved_at, row.created_at],
    );
  }
}

async function upsertKnowledge(client, rows) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO persona_kenmerk
         (id, categorie, kenmerk, soort, gevoelig, zekerheid, status, bron_object_ids,
          vervangen_door, verwerp_reden, verwerp_bron, voorganger_id, valid_from, valid_to,
          temporal_text, created_at, laatst_versterkt_op)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (id) DO UPDATE SET categorie = EXCLUDED.categorie,
         kenmerk = EXCLUDED.kenmerk, soort = EXCLUDED.soort, gevoelig = EXCLUDED.gevoelig,
         zekerheid = EXCLUDED.zekerheid, status = EXCLUDED.status,
         bron_object_ids = EXCLUDED.bron_object_ids, vervangen_door = EXCLUDED.vervangen_door,
         verwerp_reden = EXCLUDED.verwerp_reden, verwerp_bron = EXCLUDED.verwerp_bron,
         voorganger_id = EXCLUDED.voorganger_id, valid_from = EXCLUDED.valid_from,
         valid_to = EXCLUDED.valid_to, temporal_text = EXCLUDED.temporal_text,
         laatst_versterkt_op = EXCLUDED.laatst_versterkt_op, embedding = NULL`,
      [row.id, row.categorie, row.kenmerk, row.soort, row.gevoelig, row.zekerheid,
        row.status, row.bron_object_ids, row.vervangen_door, row.verwerp_reden,
        row.verwerp_bron, row.voorganger_id, row.valid_from, row.valid_to,
        row.temporal_text, row.created_at, row.laatst_versterkt_op],
    );
  }
}

async function upsertKnowledgeUsage(client, rows) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO persona_kenmerk_gebruik
         (id, kenmerk_id, gebruikt_in_object_id, context, gebruikt_op)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET kenmerk_id = EXCLUDED.kenmerk_id,
         gebruikt_in_object_id = EXCLUDED.gebruikt_in_object_id,
         context = EXCLUDED.context, gebruikt_op = EXCLUDED.gebruikt_op`,
      [row.id, row.kenmerk_id, row.gebruikt_in_object_id, row.context, row.gebruikt_op],
    );
  }
}

async function replaceSingletonTables(client, tables) {
  if (tables.personaSettings.length) {
    await client.query("DELETE FROM persona_instelling");
    for (const row of tables.personaSettings) {
      await client.query(
        `INSERT INTO persona_instelling
           (id, confidence_threshold, promotie_min_bronnen, skepticism, literalism, empathy, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [row.id, row.confidence_threshold, row.promotie_min_bronnen, row.skepticism,
          row.literalism, row.empathy, row.updated_at],
      );
    }
  }
  if (tables.pulseCache.length) {
    await client.query("DELETE FROM persona_pulse_cache");
    for (const row of tables.pulseCache) {
      await client.query(
        `INSERT INTO persona_pulse_cache (id, items, ai_used, generated_at) VALUES ($1,$2,$3,$4)`,
        [row.id, row.items, row.ai_used, row.generated_at],
      );
    }
  }
}

async function restoreMemoryWithClient(client, input) {
  const memory = validateMemoryImport(input);
  await upsertHypotheses(client, memory.tables.hypotheses);
  const episodeResult = await restoreEpisodes(client, memory.tables.episodes);
  await restoreEvidence(client, memory.tables.evidence, episodeResult.idMap);
  await upsertKnowledgeGaps(client, memory.tables.knowledgeGaps);
  await upsertKnowledge(client, memory.tables.knowledge);
  await upsertKnowledgeUsage(client, memory.tables.knowledgeUsage);
  await replaceSingletonTables(client, memory.tables);
  // These are derived/model-specific and must never remain stale after source restoration.
  await client.query("DELETE FROM object_chunk");
  await client.query("DELETE FROM object_embedding");
  return {
    mode: "merge",
    restoredAt: new Date().toISOString(),
    episodeReused: episodeResult.reused,
    counts: Object.fromEntries(TABLE_NAMES.map((name) => [name, memory.tables[name].length])),
  };
}

async function restoreMemory(pool, input) {
  validateMemoryImport(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await restoreMemoryWithClient(client, input);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Executes the exact restore path against the current schema and data, then
// always rolls it back. This catches enum/FK/id conflicts before the frontend
// uploads attachments or changes IndexedDB.
async function preflightMemoryRestore(pool, input) {
  validateMemoryImport(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await restoreMemoryWithClient(client, input);
    await client.query("ROLLBACK");
    return { compatible: true, mode: result.mode, counts: result.counts, episodeReused: result.episodeReused };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original compatibility error.
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  TABLE_NAMES,
  validateMemoryImport,
  restoreMemoryWithClient,
  restoreMemory,
  preflightMemoryRestore,
};
