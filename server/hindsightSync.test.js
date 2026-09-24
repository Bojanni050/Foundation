// Plain Node, assert-based — same convention as ingestBridge.test.js.
// hindsightSync.js is gepureerd testbaar: db-pool, client en klok gaan
// er als deps in. `node hindsightSync.test.js`.
const assert = require("assert");
const { buildFactItem, runHindsightSync, hindsightClientFromEnv, CHECKPOINT_ID } = require("./hindsightSync");
const { createHindsightClient } = require("./hindsightClient");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const FACT = {
  id: "f-1",
  inhoud: "Bo werkt aan Foundation op zondag",
  hypothesisId: "h-1",
  hypothese: "Bo werkt in het weekend aan Foundation",
  validFrom: new Date("2026-01-01T00:00:00Z"),
  validTo: null,
  temporalText: null,
  supersedesFactId: null,
  createdAt: new Date("2026-09-23T10:00:00Z"),
};

function mockPool({ checkpoint = null, facts = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes("hindsight_progress")) return { rows: checkpoint ? [checkpoint] : [] };
      if (text.includes("FROM fact")) return { rows: facts };
      return { rows: [] };
    },
  };
}

test("buildFactItem: fact wordt item met provenance in metadata", () => {
  const item = buildFactItem(FACT, { hypothese: FACT.hypothese });
  assert.strictEqual(item.content, FACT.inhoud);
  assert.strictEqual(item.context, FACT.hypothese);
  assert.strictEqual(item.timestamp, FACT.createdAt.toISOString());
  assert.strictEqual(item.documentId, FACT.id);
  assert.deepStrictEqual(item.tags, ["foundation:fact"]);
  assert.strictEqual(item.metadata.foundation_fact_id, FACT.id);
  assert.strictEqual(item.metadata.foundation_hypothesis_id, "h-1");
  assert.strictEqual(item.metadata.valid_from, FACT.validFrom.toISOString());
  assert.strictEqual(item.metadata.valid_to, undefined);
});

test("runHindsightSync: lege batch raakt Hindsight niet en zet geen watermerk", async () => {
  const retained = [];
  const pool = mockPool({ facts: [] });
  await runHindsightSync({
    client: { retain: async (item) => retained.push(item) },
    pool,
  });
  assert.strictEqual(retained.length, 0);
  assert.ok(!pool.calls.some((c) => c.text.includes("INSERT INTO hindsight_progress")));
});

test("runHindsightSync: feiten geretained, watermerk pas na succes", async () => {
  const retained = [];
  const pool = mockPool({ facts: [FACT] });
  await runHindsightSync({
    client: { retain: async (item) => retained.push(item) },
    pool,
  });
  assert.strictEqual(retained.length, 1);
  assert.strictEqual(retained[0].metadata.foundation_fact_id, FACT.id);
  const watermark = pool.calls.find((c) => c.text.includes("INSERT INTO hindsight_progress"));
  assert.ok(watermark, "watermerk moet gezet zijn");
  assert.strictEqual(watermark.values[0], CHECKPOINT_ID);
});

test("runHindsightSync: retain-fout stopt de batch, geen watermerk", async () => {
  const pool = mockPool({ facts: [FACT] });
  await runHindsightSync({
    client: { retain: async () => { throw new Error("hindsight retain onbereikbaar: x"); } },
    pool,
  });
  assert.ok(!pool.calls.some((c) => c.text.includes("INSERT INTO hindsight_progress")));
});

test("runHindsightSync: zonder client is het een no-op", async () => {
  const pool = mockPool();
  await runHindsightSync({});
  assert.strictEqual(pool.calls.length, 0);
});

test("hindsightClientFromEnv: null zonder env, client met env", () => {
  const before = { u: process.env.HINDSIGHT_URL, b: process.env.HINDSIGHT_BANK_ID };
  delete process.env.HINDSIGHT_URL;
  delete process.env.HINDSIGHT_BANK_ID;
  assert.strictEqual(hindsightClientFromEnv(), null);
  process.env.HINDSIGHT_URL = "http://127.0.0.1:4600";
  assert.strictEqual(hindsightClientFromEnv(), null);
  process.env.HINDSIGHT_BANK_ID = "bank-1";
  const client = hindsightClientFromEnv();
  assert.ok(client);
  assert.strictEqual(client.bankId, "bank-1");
  process.env.HINDSIGHT_URL = before.u;
  process.env.HINDSIGHT_BANK_ID = before.b;
});

test("createHindsightClient: retain POST naar de bank, async:true", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200 };
  };
  const client = createHindsightClient({ baseUrl: "http://127.0.0.1:4600/", bankId: "b1", fetchImpl });
  await client.retain({ content: "x", metadata: { foundation_fact_id: "f-1" } });
  assert.strictEqual(seen[0].url, "http://127.0.0.1:4600/v1/default/banks/b1/memories");
  const body = JSON.parse(seen[0].init.body);
  assert.strictEqual(body.async, true);
  assert.strictEqual(body.items[0].content, "x");
  assert.strictEqual(body.items[0].metadata.foundation_fact_id, "f-1");
});

test("createHindsightClient: niet-ok antwoord wordt een fout", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const client = createHindsightClient({ baseUrl: "http://127.0.0.1:4600", bankId: "b1", fetchImpl });
  await assert.rejects(() => client.retain({ content: "x" }), /antwoordde 500/);
});

test("createHindsightClient: healthy false bij onbereikbare Hindsight", async () => {
  const fetchImpl = async () => { throw new Error("econnrefused"); };
  const client = createHindsightClient({ baseUrl: "http://127.0.0.1:4600", bankId: "b1", fetchImpl });
  assert.strictEqual(await client.healthy(), false);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok - ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL - ${t.name}`);
      console.error(`    ${err.message}`);
    }
  }
  if (failed > 0) { console.error(`${failed} test(s) failed`); process.exit(1); }
  console.log(`${tests.length} tests geslaagd`);
})();
