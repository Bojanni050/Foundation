// Plain Node, assert-based — same convention as ingestPolicy.test.js.
// ingestBridgeMapping.js is pure (no DB, no clock), so every case here is a
// plain function call: `node ingestBridge.test.js`.
const assert = require("assert");
const { prepareEpisodeInput } = require("./episodePolicy");
const {
  SOURCE_TYPE_BY_OBJECT_TYPE,
  mapIngestRowToEpisodeInput,
} = require("./ingestBridgeMapping");

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const ROW = {
  id: "d1017c05-294c-4c7b-8c2c-9b8aa0f95819",
  object_type: "chat",
  content: "smoke test gesprek",
  url: "https://chatgpt.com/c/abc123",
  provider_conversation_id: "chatgpt:abc123",
  occurred_at: new Date("2026-09-23T12:39:02.019Z"),
  ingested_at: new Date("2026-09-23T12:39:02.019Z"),
};

test("each ingest object_type maps to a fixed episode sourceType", () => {
  assert.deepStrictEqual(SOURCE_TYPE_BY_OBJECT_TYPE, {
    chat: "chat-import",
    document: "document",
    diary: "explicit-input",
    capture: "system-observation",
  });
});

test("chat row becomes an episode input with ingest provenance", () => {
  const input = mapIngestRowToEpisodeInput(ROW);
  assert.strictEqual(input.bronObjectId, "ingest:" + ROW.id);
  assert.strictEqual(input.bronsoort, "chat");
  assert.strictEqual(input.fragment, ROW.content); // verbatim — never rewritten
  assert.strictEqual(input.sourceType, "chat-import");
  assert.strictEqual(input.observedAt, ROW.occurred_at);
  assert.strictEqual(input.bronReferentie, ROW.url);
  assert.strictEqual(input.conversationIdentity, ROW.provider_conversation_id);
});

test("typeward: an unknown object_type fails loudly", () => {
  assert.throws(
    () => mapIngestRowToEpisodeInput({ ...ROW, object_type: "carrier-pigeon" }),
    TypeError
  );
});

test("observedAt falls back to ingested_at when occurred_at is null", () => {
  const input = mapIngestRowToEpisodeInput({ ...ROW, occurred_at: null });
  assert.strictEqual(input.observedAt, ROW.ingested_at);
});

test("null provenance fields map to null and stay policy-valid", () => {
  const input = mapIngestRowToEpisodeInput({
    ...ROW,
    url: null,
    provider_conversation_id: null,
  });
  assert.strictEqual(input.bronReferentie, null);
  assert.strictEqual(input.conversationIdentity, null);
  const episode = prepareEpisodeInput(input);
  assert.strictEqual(episode.observationHash.length, 64);
});

test("mapping output is stable: same row, same observationHash (idempotent bridge)", () => {
  const a = prepareEpisodeInput(mapIngestRowToEpisodeInput(ROW));
  const b = prepareEpisodeInput(mapIngestRowToEpisodeInput({ ...ROW }));
  assert.strictEqual(a.observationHash, b.observationHash);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log("  ok  " + name);
  } catch (err) {
    failed++;
    console.error("  FAIL  " + name + "\n      " + err.message);
  }
}
if (failed > 0) {
  console.error("\n" + failed + " ingest bridge test(s) failed");
  process.exit(1);
}
console.log("\nAll " + tests.length + " ingest bridge tests passed");
