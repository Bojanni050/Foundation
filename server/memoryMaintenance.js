async function getMemoryStorageInventory(pool) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM object_chunk) AS object_chunks,
       (SELECT COUNT(*)::int FROM object_embedding) AS object_embeddings,
       (SELECT COUNT(*)::int FROM episode) AS episodes,
       (SELECT COUNT(*)::int FROM evidence) AS evidence,
       (SELECT COUNT(*)::int FROM hypothesis) AS hypotheses,
       (SELECT COUNT(*)::int FROM persona_kenmerk) AS knowledge,
       (pg_total_relation_size('object_chunk') + pg_total_relation_size('object_embedding'))::bigint
         AS derived_bytes`,
  );
  return rows[0];
}

async function getObjectIndexInventory(pool) {
  const { rows } = await pool.query(
    `SELECT COALESCE(oe.object_id, oc.object_id) AS object_id,
       oe.created_at AS object_indexed_at,
       COUNT(oc.id)::int AS chunk_count,
       COUNT(oc.embedding)::int AS embedded_chunk_count
     FROM object_embedding oe
     FULL OUTER JOIN object_chunk oc ON oc.object_id = oe.object_id
     GROUP BY COALESCE(oe.object_id, oc.object_id), oe.created_at
     ORDER BY COALESCE(oe.object_id, oc.object_id)`,
  );
  return rows;
}

async function purgeDerivedMemory(pool, confirmation) {
  if (confirmation !== "PURGE_DERIVED_MEMORY") {
    throw new TypeError("explicit derived-memory purge confirmation required");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const chunks = await client.query("DELETE FROM object_chunk");
    const embeddings = await client.query("DELETE FROM object_embedding");
    await client.query("COMMIT");
    return { objectChunks: chunks.rowCount, objectEmbeddings: embeddings.rowCount };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getMemoryStorageInventory, getObjectIndexInventory, purgeDerivedMemory };
