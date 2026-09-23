import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildMemoryExport } = require("../server/memoryExport");
const { restoreMemoryWithClient } = require("../server/memoryRestore");
const { getMemoryStorageInventory, getObjectIndexInventory } = require("../server/memoryMaintenance");
const { auditMemoryIntegrity } = require("../server/memoryIntegrity");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

await client.connect();
await client.query("BEGIN");

try {
  const { rows: columns } = await client.query(
    `SELECT column_name, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'evidence'`,
  );
  const byName = new Map(columns.map((column) => [column.column_name, column]));
  assert.equal(byName.get("episode_id")?.is_nullable, "NO");
  assert.equal(byName.has("fragment"), false, "legacy observation fields must be removed from evidence");

  const { rows: firstHypothesisRows } = await client.query(
    "INSERT INTO hypothesis (hypothese) VALUES ($1) RETURNING id",
    ["episode integration test A"],
  );
  const { rows: secondHypothesisRows } = await client.query(
    "INSERT INTO hypothesis (hypothese) VALUES ($1) RETURNING id",
    ["episode integration test B"],
  );
  const firstHypothesisId = firstHypothesisRows[0].id;
  const secondHypothesisId = secondHypothesisRows[0].id;

  const { rows: episodeRows } = await client.query(
    `INSERT INTO episode
       (bron_object_id, bronsoort, fragment, source_type, extraction_confidence, observation_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    ["obj_integration", "note", "frozen observation", "explicit-input", 100, `test:${randomUUID()}`],
  );
  const episodeId = episodeRows[0].id;

  await client.query(
    "INSERT INTO evidence (hypothesis_id, episode_id, richting) VALUES ($1, $2, 'supporting')",
    [firstHypothesisId, episodeId],
  );
  await client.query(
    "INSERT INTO evidence (hypothesis_id, episode_id, richting) VALUES ($1, $2, 'contradicting')",
    [secondHypothesisId, episodeId],
  );

  const { rows: reuseRows } = await client.query(
    "SELECT count(*)::int AS count FROM evidence WHERE episode_id = $1",
    [episodeId],
  );
  assert.equal(reuseRows[0].count, 2, "one episode must be reusable across hypotheses");

  const { rows: secondEpisodeRows } = await client.query(
    `INSERT INTO episode
       (bron_object_id, bronsoort, fragment, source_type, extraction_confidence, observation_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    ["obj_integration", "note", "second frozen observation", "explicit-input", 100, `test:${randomUUID()}`],
  );
  await client.query(
    "INSERT INTO evidence (hypothesis_id, episode_id, richting) VALUES ($1, $2, 'contextualizing')",
    [firstHypothesisId, secondEpisodeRows[0].id],
  );

  const { rows: usageRows } = await client.query(
    `SELECT
       COUNT(DISTINCT ep.id)::int AS episode_count,
       COUNT(e.id)::int AS evidence_count,
       COUNT(DISTINCT e.hypothesis_id)::int AS hypothesis_count
     FROM episode ep
     LEFT JOIN evidence e ON e.episode_id = ep.id
     WHERE ep.bron_object_id = $1`,
    ["obj_integration"],
  );
  assert.deepEqual(usageRows[0], {
    episode_count: 2,
    evidence_count: 3,
    hypothesis_count: 2,
  });

  const memoryExport = await buildMemoryExport(client);
  assert.equal(memoryExport.format, "foundation-chronicle-memory");
  assert.ok(memoryExport.tables.episodes.some((row) => row.id === episodeId));
  assert.ok(memoryExport.tables.evidence.some((row) => row.episode_id === episodeId));
  assert.ok(
    memoryExport.tables.knowledge.every((row) => !("embedding" in row)),
    "portable memory export must not include derived embedding vectors",
  );
  const restoreResult = await restoreMemoryWithClient(client, memoryExport);
  assert.ok(restoreResult.episodeReused >= 2, "restore must reuse immutable episodes by hash");
  assert.equal(restoreResult.counts.evidence, memoryExport.tables.evidence.length);

  const storageInventory = await getMemoryStorageInventory(client);
  assert.ok(storageInventory.episodes >= 2);
  assert.ok(storageInventory.evidence >= 3);
  assert.ok(Number(storageInventory.derived_bytes) >= 0);

  const indexObjectId = `obj_index_${randomUUID()}`;
  await client.query(
    "INSERT INTO object_chunk (object_id, content, order_index) VALUES ($1, $2, 0)",
    [indexObjectId, "integration test chunk"],
  );
  await client.query("INSERT INTO object_embedding (object_id) VALUES ($1)", [indexObjectId]);
  const indexInventory = await getObjectIndexInventory(client);
  const indexedObject = indexInventory.find((row) => row.object_id === indexObjectId);
  assert.equal(indexedObject.chunk_count, 1);
  assert.equal(indexedObject.embedded_chunk_count, 0);

  const auditBeforeOrphan = await auditMemoryIntegrity(client, { objectIds: [indexObjectId, "obj_integration"] });
  const orphanIndexObjectId = `obj_orphan_${randomUUID()}`;
  await client.query(
    "INSERT INTO object_chunk (object_id, content, order_index) VALUES ($1, $2, 0)",
    [orphanIndexObjectId, "orphan integration test chunk"],
  );
  const auditAfterOrphan = await auditMemoryIntegrity(client, { objectIds: [indexObjectId, "obj_integration"] });
  assert.equal(
    auditAfterOrphan.orphanDerivedIndexes.count,
    auditBeforeOrphan.orphanDerivedIndexes.count + 1,
    "integrity audit must detect a derived index without an IndexedDB source object",
  );

  await client.query("SAVEPOINT duplicate_evidence");
  try {
    await client.query(
      "INSERT INTO evidence (hypothesis_id, episode_id, richting) VALUES ($1, $2, 'contextualizing')",
      [firstHypothesisId, episodeId],
    );
    assert.fail("duplicate hypothesis/episode link should fail");
  } catch (error) {
    assert.equal(error.code, "23505");
    await client.query("ROLLBACK TO SAVEPOINT duplicate_evidence");
  }

  await client.query("SAVEPOINT immutable_episode");
  try {
    await client.query("UPDATE episode SET fragment = 'changed' WHERE id = $1", [episodeId]);
    assert.fail("episode update should fail");
  } catch (error) {
    assert.equal(error.code, "55000");
    await client.query("ROLLBACK TO SAVEPOINT immutable_episode");
  }

  console.log("ok - migrated episode schema, reuse, uniqueness, and append-only trigger");
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
