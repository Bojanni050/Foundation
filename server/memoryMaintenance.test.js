const assert = require("node:assert/strict");
const { purgeDerivedMemory } = require("./memoryMaintenance");

assert.rejects(
  () => purgeDerivedMemory({}, "wrong"),
  /explicit derived-memory purge confirmation required/,
).then(async () => {
  const queries = [];
  const client = {
    async query(text) {
      queries.push(text);
      return { rowCount: text.includes("object_chunk") ? 3 : text.includes("object_embedding") ? 2 : null };
    },
    release() { queries.push("RELEASE"); },
  };
  const result = await purgeDerivedMemory({ connect: async () => client }, "PURGE_DERIVED_MEMORY");
  assert.deepEqual(result, { objectChunks: 3, objectEmbeddings: 2 });
  assert.deepEqual(queries, [
    "BEGIN",
    "DELETE FROM object_chunk",
    "DELETE FROM object_embedding",
    "COMMIT",
    "RELEASE",
  ]);
  console.log("ok - derived-memory purge is confirmed and transactional");
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
