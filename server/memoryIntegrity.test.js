const assert = require("node:assert/strict");
const {
  normalizeObjectIds,
  auditMemoryIntegrity,
  purgeOrphanDerivedIndexes,
} = require("./memoryIntegrity");

assert.deepEqual(normalizeObjectIds(["obj_a", "obj_a", "", null, "obj_b"]), ["obj_a", "obj_b"]);
assert.throws(() => normalizeObjectIds(null), /objectIds must be an array/);

const auditCalls = [];
auditMemoryIntegrity({
  async query(text, values) {
    auditCalls.push({ text, values });
    return { rows: [] };
  },
}, { objectIds: ["obj_a"] }).then(async (report) => {
  assert.equal(auditCalls.length, 4);
  assert.equal(report.auditedObjectCount, 1);
  assert.equal(report.orphanDerivedIndexes.count, 0);

  await assert.rejects(
    () => purgeOrphanDerivedIndexes({}, { objectIds: [], confirmation: "wrong" }),
    /explicit orphan-index purge confirmation required/,
  );
  const transaction = [];
  const client = {
    async query(text) {
      transaction.push(text);
      return { rowCount: text.includes("object_chunk") ? 2 : text.includes("object_embedding") ? 1 : null };
    },
    release() { transaction.push("RELEASE"); },
  };
  const result = await purgeOrphanDerivedIndexes(
    { connect: async () => client },
    { objectIds: ["obj_a"], confirmation: "PURGE_ORPHAN_DERIVED_INDEXES" },
  );
  assert.deepEqual(result, { objectChunks: 2, objectEmbeddings: 1 });
  assert.deepEqual(transaction, [
    "BEGIN",
    "DELETE FROM object_chunk WHERE NOT (object_id = ANY($1::text[]))",
    "DELETE FROM object_embedding WHERE NOT (object_id = ANY($1::text[]))",
    "COMMIT",
    "RELEASE",
  ]);
  console.log("ok - cross-store integrity audit and safe derived repair");
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
