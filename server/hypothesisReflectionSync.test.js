// Plain Node, assert-based — same convention as ingestBridge.test.js.
// Alle deps (pool, embed, reflector, create/link) worden geïnjecteerd —
// geen DB, geen ONNX-model, geen LLM in deze test. `node hypothesisReflectionSync.test.js`.
const assert = require("assert");
const {
  runHypothesisReflectionSync,
  reflectorFromEnv,
  buildJudgePrompt,
  parseJudgeOutput,
} = require("./hypothesisReflectionSync");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const EPISODES = [
  { id: "ep-1", fragment: "Bo zei dat zijn favoriete kleur nu groen is", bronsoort: "chat", captured_at: new Date("2026-09-23T10:00:00Z"), observed_at: null },
  { id: "ep-2", fragment: "Bo's favoriete kleur was vroeger blauw", bronsoort: "chat", captured_at: new Date("2026-09-23T10:05:00Z"), observed_at: null },
];
const FACTS = [
  { id: "fact-1", inhoud: "Bo's favoriete kleur is blauw", temporal_text: null },
];

function makePool({ checkpoint = null, episodes = [], facts = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes("reflection_progress")) return { rows: checkpoint ? [checkpoint] : [] };
      if (text.includes("FROM episode")) return { rows: episodes };
      if (text.includes("FROM fact f")) return { rows: facts };
      return { rows: [] };
    },
  };
}

const fakeEmbed = async () => [0.1, 0.2, 0.3];
const fakeCreate = async (input) => ({ hypothesis: { id: "new-hyp", ...input }, matched: false });
const fakeLink = async (input) => ({ id: "ev-1", ...input });

test("parseJudgeOutput: geldige proposals worden gefilterd op vereiste velden", () => {
  const out = parseJudgeOutput(JSON.stringify({
    proposals: [
      { type: "update", factId: "f1", hypothese: "x", reden: "r", evidence: [{ episodeId: "ep1", richting: "supporting" }] },
      { type: "update" },
      null,
      { type: "contradictie", factId: "f2", hypothese: "y", reden: "r", evidence: [] },
    ],
  }));
  assert.strictEqual(out.length, 2);
});

test("parseJudgeOutput: ongeldige JSON wordt een fout", () => {
  assert.throws(() => parseJudgeOutput("geen json"), /geen geldige JSON/);
});

test("buildJudgePrompt: episodes en feiten met ids in de prompt", () => {
  const prompt = buildJudgePrompt(EPISODES, FACTS);
  assert.ok(prompt.includes("ep-1"));
  assert.ok(prompt.includes("fact-1"));
  assert.ok(prompt.includes("Bo's favoriete kleur is blauw"));
});

test("runHypothesisReflectionSync: zonder reflector is het een no-op", async () => {
  const pool = makePool();
  await runHypothesisReflectionSync({});
  assert.strictEqual(pool.calls.length, 0);
});

test("runHypothesisReflectionSync: voorstel wordt open hypothese + evidence, watermerk pas na succes", async () => {
  const pool = makePool({ episodes: EPISODES, facts: FACTS.map((f) => ({ ...f, semantic_relevance: 0.9 })) });
  const created = [], linked = [];
  await runHypothesisReflectionSync({
    reflector: { judge: async () => [{ type: "update", factId: "fact-1", hypothese: "Bo's favoriete kleur is groen", reden: "recenter", evidence: [{ episodeId: "ep-1", richting: "supporting" }, { episodeId: "ep-2", richting: "contradicting" }] }] },
    pool,
    embed: fakeEmbed,
    createOrReuseHypothesis: async (input) => { created.push(input); return { hypothesis: { id: "h-1" }, matched: false }; },
    linkEvidence: async (input) => { linked.push(input); return { id: "e" }; },
  });
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].supersedesFactId, "fact-1");
  assert.strictEqual(linked.length, 2);
  assert.deepStrictEqual(linked.map((l) => l.richting).sort(), ["contradicting", "supporting"]);
  const watermark = pool.calls.find((c) => c.text.includes("INSERT INTO reflection_progress"));
  assert.ok(watermark, "watermerk moet gezet zijn");
});

test("runHypothesisReflectionSync: contradictie koppelt GEEN supersedes (alleen update)", async () => {
  const created = [];
  await runHypothesisReflectionSync({
    reflector: { judge: async () => [{ type: "contradictie", factId: "fact-1", hypothese: "x", reden: "r", evidence: [] }] },
    pool: makePool({ episodes: EPISODES, facts: FACTS.map((f) => ({ ...f, semantic_relevance: 0.9 })) }),
    embed: fakeEmbed,
    createOrReuseHypothesis: async (input) => { created.push(input); return { hypothesis: { id: "h-2" }, matched: false }; },
    linkEvidence: fakeLink,
  });
  assert.strictEqual(created[0].supersedesFactId, null);
});

test("runHypothesisReflectionSync: LLM-fout → geen watermerk, volgende run herpakt", async () => {
  const pool = makePool({ episodes: EPISODES, facts: FACTS.map((f) => ({ ...f, semantic_relevance: 0.9 })) });
  await runHypothesisReflectionSync({
    reflector: { judge: async () => { throw new Error("reflectie-LLM onbereikbaar: x"); } },
    pool,
    embed: fakeEmbed,
    createOrReuseHypothesis: fakeCreate,
    linkEvidence: fakeLink,
  });
  assert.ok(!pool.calls.some((c) => c.text.includes("INSERT INTO reflection_progress")));
});

test("runHypothesisReflectionSync: geen relevante feiten → alleen watermerk, geen LLM-call", async () => {
  const pool = makePool({ episodes: EPISODES, facts: [] });
  let judged = false;
  await runHypothesisReflectionSync({
    reflector: { judge: async () => { judged = true; return []; } },
    pool,
    embed: fakeEmbed,
    createOrReuseHypothesis: fakeCreate,
    linkEvidence: fakeLink,
  });
  assert.strictEqual(judged, false);
  assert.ok(pool.calls.some((c) => c.text.includes("INSERT INTO reflection_progress")));
});

test("runHypothesisReflectionSync: max 3 voorstellen per run", async () => {
  const created = [];
  const five = Array.from({ length: 5 }, (_, i) => ({ type: "update", factId: `f-${i}`, hypothese: `h ${i}`, reden: "r", evidence: [] }));
  await runHypothesisReflectionSync({
    reflector: { judge: async () => five },
    pool: makePool({ episodes: EPISODES, facts: FACTS.map((f) => ({ ...f, semantic_relevance: 0.9 })) }),
    embed: fakeEmbed,
    createOrReuseHypothesis: async (input) => { created.push(input); return { hypothesis: { id: "h" }, matched: false }; },
    linkEvidence: fakeLink,
  });
  assert.strictEqual(created.length, 3);
});

test("reflectorFromEnv: null zonder env, aanwezig met alle drie", () => {
  const before = { k: process.env.REFLECTION_LLM_API_KEY, b: process.env.REFLECTION_LLM_BASE_URL, m: process.env.REFLECTION_LLM_MODEL };
  delete process.env.REFLECTION_LLM_API_KEY;
  delete process.env.REFLECTION_LLM_BASE_URL;
  delete process.env.REFLECTION_LLM_MODEL;
  assert.strictEqual(reflectorFromEnv(), null);
  process.env.REFLECTION_LLM_API_KEY = "key";
  assert.strictEqual(reflectorFromEnv(), null);
  process.env.REFLECTION_LLM_BASE_URL = "http://127.0.0.1:1234";
  process.env.REFLECTION_LLM_MODEL = "m";
  const r = reflectorFromEnv();
  assert.ok(r);
  assert.strictEqual(r.model, "m");
  process.env.REFLECTION_LLM_API_KEY = before.k;
  process.env.REFLECTION_LLM_BASE_URL = before.b;
  process.env.REFLECTION_LLM_MODEL = before.m;
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
