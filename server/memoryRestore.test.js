const assert = require("node:assert/strict");
const { validateMemoryImport, restoreMemory, preflightMemoryRestore, TABLE_NAMES } = require("./memoryRestore");

function emptyMemory() {
  return {
    format: "foundation-chronicle-memory",
    version: 1,
    tables: Object.fromEntries(TABLE_NAMES.map((name) => [name, []])),
  };
}

assert.throws(() => validateMemoryImport({}), /Not a Chronicle memory export/);
assert.throws(() => validateMemoryImport({ ...emptyMemory(), version: 99 }), /Unsupported/);

const queries = [];
const client = {
  async query(text) {
    queries.push(text);
    return { rows: [] };
  },
  release() { queries.push("RELEASE"); },
};

restoreMemory({ connect: async () => client }, emptyMemory()).then((result) => {
  assert.equal(result.mode, "merge");
  assert.equal(result.counts.episodes, 0);
  assert.deepEqual(queries.slice(0, 4), ["BEGIN", "DELETE FROM object_chunk", "DELETE FROM object_embedding", "COMMIT"]);
  assert.equal(queries.at(-1), "RELEASE");
  const preflightQueries = [];
  const preflightClient = {
    async query(text) {
      preflightQueries.push(text);
      return { rows: [], rowCount: 0 };
    },
    release() { preflightQueries.push("RELEASE"); },
  };
  return preflightMemoryRestore({ connect: async () => preflightClient }, emptyMemory()).then((preflight) => {
    assert.equal(preflight.compatible, true);
    assert.equal(preflightQueries.includes("COMMIT"), false);
    assert.deepEqual(preflightQueries.slice(-2), ["ROLLBACK", "RELEASE"]);
    console.log("ok - memory restore validation, commit, and rollback-only preflight");
  });
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
