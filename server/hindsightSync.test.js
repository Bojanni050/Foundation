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

test("buildFactItem: snake_case DB-rij → volledige provenance (regressie: camelCase-aanname gaf timestamp 'unset' in prod)", () => {
  const row = {
    id: "f-9",
    inhoud: "Feit uit een echte Postgres-rij",
    hypothesis_id: "h-9",
    valid_from: new Date("2026-02-01T00:00:00Z"),
    valid_to: null,
    temporal_text: "sinds februari 2026",
    supersedes_fact_id: "f-3",
    created_at: new Date("2026-09-30T12:00:00Z"),
    hypothese: "Onderliggende hypothese-tekst",
  };
  const item = buildFactItem(row, { hypothese: row.hypothese });
  assert.strictEqual(item.timestamp, "2026-09-30T12:00:00.000Z");
  assert.strictEqual(item.context, "Onderliggende hypothese-tekst");
  assert.strictEqual(item.metadata.foundation_hypothesis_id, "h-9");
  assert.strictEqual(item.metadata.valid_from, "2026-02-01T00:00:00.000Z");
  assert.strictEqual(item.metadata.temporal_text, "sinds februari 2026");
  assert.strictEqual(item.metadata.supersedes_fact_id, "f-3");
  assert.ok(!("valid_to" in item.metadata), "null velden blijven weg uit metadata");
});

test("runHindsightSync: burst boven BATCH_LIMIT → watermerk op laatste bewaarde fact, rest volgende run (nooit versprongen)", async () => {
  const facts = Array.from({ length: 26 }, (_, i) => ({
    id: `burst-${i}`,
    inhoud: `feit ${i}`,
    hypothesis_id: `h-${i}`,
    created_at: new Date(Date.parse("2025-01-01T00:00:00Z") + i * 1000),
  }));
  let wm = null;
  const watermarks = [];
  const pool = {
    async query(text, values) {
      if (text.startsWith("SELECT last_fact_created_at")) return { rows: wm ? [{ last_fact_created_at: wm }] : [] };
      if (text.startsWith("INSERT INTO hindsight_progress")) { wm = values[1]; watermarks.push(wm); return { rows: [] }; }
      if (text.includes("FROM fact")) {
        const [lastAt, upper, limit] = values;
        return {
          rows: facts
            .filter((f) => f.created_at > (lastAt ?? new Date(0)) && f.created_at <= upper)
            .slice(0, limit),
        };
      }
      return { rows: [] };
    },
  };
  const retained = [];
  const client = { retain: async (item) => retained.push(item) };

  await runHindsightSync({ client, pool });
  assert.strictEqual(retained.length, 25, "eerste run: precies BATCH_LIMIT feiten");
  assert.strictEqual(watermarks.length, 1);
  assert.strictEqual(watermarks[0].toISOString(), facts[24].created_at.toISOString(),
    "watermerk op de LAATSTE verwerkte fact, niet op nu");

  await runHindsightSync({ client, pool });
  assert.strictEqual(retained.length, 26, "tweede run: de 26ste fact alsnog geretain, niet versprongen");
  assert.strictEqual(watermarks[1].toISOString(), facts[25].created_at.toISOString());
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
