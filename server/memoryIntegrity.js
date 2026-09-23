function normalizeObjectIds(objectIds) {
  if (!Array.isArray(objectIds)) throw new TypeError("objectIds must be an array");
  return [...new Set(objectIds.filter((id) => typeof id === "string" && id.length > 0))];
}

function resultGroup(rows) {
  return {
    count: Number(rows[0]?.total_count || 0),
    items: rows.map(({ total_count: _totalCount, ...row }) => row),
  };
}

async function auditMemoryIntegrity(pool, input) {
  const objectIds = normalizeObjectIds(input?.objectIds);
  const episodeResult = await pool.query(
      `WITH missing AS (
         SELECT DISTINCT ON (bron_object_id) id, bron_object_id, bronsoort, captured_at
         FROM episode
         WHERE NOT (bron_object_id = ANY($1::text[]))
         ORDER BY bron_object_id, captured_at DESC
       )
       SELECT id, bron_object_id, bronsoort, captured_at, COUNT(*) OVER()::int AS total_count
       FROM missing ORDER BY captured_at DESC LIMIT 50`,
      [objectIds],
    );
  const knowledgeResult = await pool.query(
      `WITH missing AS (
         SELECT id, kenmerk,
           ARRAY(SELECT ref FROM unnest(bron_object_ids) AS ref WHERE NOT (ref = ANY($1::text[]))) AS missing_object_ids
         FROM persona_kenmerk
       )
       SELECT id, kenmerk, missing_object_ids, COUNT(*) OVER()::int AS total_count
       FROM missing WHERE cardinality(missing_object_ids) > 0
       ORDER BY id LIMIT 50`,
      [objectIds],
    );
  const usageResult = await pool.query(
      `SELECT id, kenmerk_id, gebruikt_in_object_id, gebruikt_op, COUNT(*) OVER()::int AS total_count
       FROM persona_kenmerk_gebruik
       WHERE NOT (gebruikt_in_object_id = ANY($1::text[]))
       ORDER BY gebruikt_op DESC LIMIT 50`,
      [objectIds],
    );
  const indexResult = await pool.query(
      `WITH indexed AS (
         SELECT object_id FROM object_chunk
         UNION
         SELECT object_id FROM object_embedding
       )
       SELECT object_id, COUNT(*) OVER()::int AS total_count
       FROM indexed WHERE NOT (object_id = ANY($1::text[]))
       ORDER BY object_id LIMIT 50`,
      [objectIds],
    );
  return {
    auditedObjectCount: objectIds.length,
    missingEpisodeSources: resultGroup(episodeResult.rows),
    missingKnowledgeSources: resultGroup(knowledgeResult.rows),
    missingUsageObjects: resultGroup(usageResult.rows),
    orphanDerivedIndexes: resultGroup(indexResult.rows),
  };
}

async function purgeOrphanDerivedIndexes(pool, input) {
  if (input?.confirmation !== "PURGE_ORPHAN_DERIVED_INDEXES") {
    throw new TypeError("explicit orphan-index purge confirmation required");
  }
  const objectIds = normalizeObjectIds(input.objectIds);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const chunks = await client.query(
      "DELETE FROM object_chunk WHERE NOT (object_id = ANY($1::text[]))",
      [objectIds],
    );
    const embeddings = await client.query(
      "DELETE FROM object_embedding WHERE NOT (object_id = ANY($1::text[]))",
      [objectIds],
    );
    await client.query("COMMIT");
    return { objectChunks: chunks.rowCount, objectEmbeddings: embeddings.rowCount };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { normalizeObjectIds, auditMemoryIntegrity, purgeOrphanDerivedIndexes };
