const assert = require("assert");
const { EXPORT_QUERIES, buildMemoryExport } = require("./memoryExport");

(async () => {
  const calls = [];
  const pool = {
    async query(query) {
      calls.push(query);
      return { rows: [{ queryNumber: calls.length }] };
    },
  };

  const result = await buildMemoryExport(pool);
  assert.equal(result.format, "foundation-chronicle-memory");
  assert.equal(result.version, 1);
  assert.deepEqual(Object.keys(result.tables), Object.keys(EXPORT_QUERIES));
  assert.equal(calls.length, Object.keys(EXPORT_QUERIES).length);
  assert.ok(calls.every((query) => !/SELECT\s+\*/i.test(query)), "backup queries must use explicit columns");
  assert.ok(calls.every((query) => !/\bembedding\b/i.test(query)), "derived embeddings must not be exported");
  assert.ok(result.derivedDataExcluded.includes("object_chunk"));
  console.log("ok - memory export uses explicit portable columns and excludes derived vectors");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
