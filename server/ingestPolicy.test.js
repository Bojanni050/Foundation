// Plain Node, assert-based — same convention as epistemicPolicy.test.js.
// ingestPolicy.js is pure (no DB, no clock), so every case here is a plain
// function call: `node ingestPolicy.test.js`.
const assert = require("assert");
const { normalizeIngestRecord } = require("./ingestPolicy");

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("chat: valid payload becomes an observation record", () => {
  const result = normalizeIngestRecord("chat", {
    content: "Gebruiker vraagt over migraties",
    sourceProvider: "chatgpt",
    url: "https://chatgpt.com/c/6198b802-abcd",
    turns: [{ role: "user", text: "vraag" }],
    tags: ["work"],
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.record.status, "observation");
  assert.strictEqual(result.record.objectType, "chat");
  assert.strictEqual(result.record.source, "chat-import");
  assert.deepStrictEqual(result.record.tags, ["work"]);
});

test("status is refused from the client — always", () => {
  for (const objectType of ["chat", "capture", "document", "diary"]) {
    const result = normalizeIngestRecord(objectType, { content: "x", source: "s", status: "confirmed" });
    assert.strictEqual(result.ok, false, `${objectType} must refuse a client status`);
    assert.ok(result.errors.some((e) => e.includes('"status"')));
  }
});

test("server-owned identity fields are refused on every entry-point", () => {
  for (const field of ["providerConversationId", "contentHash", "id", "objectType"]) {
    const result = normalizeIngestRecord("chat", { content: "x", [field]: "forged" });
    assert.strictEqual(result.ok, false, `${field} must be refused`);
    assert.ok(result.errors.some((e) => e.includes(`"${field}"`)));
  }
});

test("typeward: capture may not carry turns (a capture is not a conversation)", () => {
  const result = normalizeIngestRecord("capture", {
    content: "active window: VS Code",
    source: "capture-rs",
    turns: [{ role: "user", text: "geen gesprek" }],
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("unknown field \"turns\"")));
});

test("typeward: document and capture require an explicit source", () => {
  assert.strictEqual(normalizeIngestRecord("document", { content: "x" }).ok, false);
  assert.strictEqual(normalizeIngestRecord("capture", { content: "x" }).ok, false);
  const doc = normalizeIngestRecord("document", { content: "x", source: "manual-share" });
  assert.strictEqual(doc.ok, true);
  assert.strictEqual(doc.record.source, "manual-share");
});

test("diary may carry turns (transcript segmenten) and defaults its source", () => {
  const result = normalizeIngestRecord("diary", {
    content: "audio-log 12 min",
    turns: [{ text: "fragment", start: 0 }],
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.record.source, "diary");
  assert.strictEqual(result.record.turns.length, 1);
});

test("required content: empty or missing content is rejected everywhere", () => {
  for (const objectType of ["chat", "capture", "document", "diary"]) {
    assert.strictEqual(normalizeIngestRecord(objectType, { source: "s" }).ok, false, `${objectType} without content`);
    assert.strictEqual(normalizeIngestRecord(objectType, { content: "   ", source: "s" }).ok, false, `${objectType} with blank content`);
  }
});

test("malformed shapes fail loudly: turns without text, non-string tags, bad timestamp", () => {
  const badTurns = normalizeIngestRecord("chat", { content: "x", turns: [{ role: "user" }] });
  assert.strictEqual(badTurns.ok, false);

  const badTags = normalizeIngestRecord("document", { content: "x", source: "s", tags: ["ok", 42] });
  assert.strictEqual(badTags.ok, false);

  const badTime = normalizeIngestRecord("diary", { content: "x", occurredAt: "gisteren" });
  assert.strictEqual(badTime.ok, false);
});

test("unknown fields are refused (exact contract, no silent drop)", () => {
  const result = normalizeIngestRecord("chat", { content: "x", sourceProvder: "chatgpt" });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("unknown field \"sourceProvder\"")));
});

test("unknown object type is rejected", () => {
  const result = normalizeIngestRecord("telepathy", { content: "x" });
  assert.strictEqual(result.ok, false);
});

test("all validation errors are reported together, not first-only", () => {
  const result = normalizeIngestRecord("capture", { status: "confirmed", content: "", source: "" });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.length >= 3, `expected combined errors, got: ${result.errors}`);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL  ${name}`);
      console.error(`      ${err.message}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} ingest policy tests passed`);
})();
