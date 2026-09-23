// Plain Node, assert-based — same convention as epistemicPolicy.test.js.
const assert = require("assert");
const { temporalFit, sourceQualityFromEvidence, confidenceScore, combinedScore, DEFAULT_WEIGHTS } = require("./retrievalPolicy");

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("temporal fit: no declared window always fits", () => {
  assert.strictEqual(temporalFit({}), 1);
});

test("temporal fit: inside a declared window fits, outside does not", () => {
  const item = { valid_from: "2026-01-01T00:00:00Z", valid_to: "2026-12-31T00:00:00Z" };
  assert.strictEqual(temporalFit(item, "2026-06-01T00:00:00Z"), 1);
  assert.strictEqual(temporalFit(item, "2027-01-15T00:00:00Z"), 0, "expired must not fit");
  assert.strictEqual(temporalFit(item, "2025-01-01T00:00:00Z"), 0, "not-yet-valid must not fit");
});

test("temporal fit: accepts either snake_case (raw pg row) or camelCase", () => {
  assert.strictEqual(temporalFit({ validFrom: "2026-01-01T00:00:00Z" }, "2026-06-01T00:00:00Z"), 1);
});

test("source quality: unknown confidence is neutral, not penalized", () => {
  assert.strictEqual(sourceQualityFromEvidence([]), 0.5);
  assert.strictEqual(sourceQualityFromEvidence([{ episode: {} }]), 0.5);
});

test("source quality: averages and normalizes episode extraction confidence", () => {
  const evidence = [{ episode: { extraction_confidence: 80 } }, { episode: { extraction_confidence: 60 } }];
  assert.strictEqual(sourceQualityFromEvidence(evidence), 0.7);
});

test("confidence: confirmed beats superseded, superseded beats rejected", () => {
  assert.strictEqual(confidenceScore({ status: "confirmed", superseded: false }), 1);
  assert.strictEqual(confidenceScore({ status: "confirmed", superseded: true }), 0.5);
  assert.strictEqual(confidenceScore({ status: "rejected" }), 0);
});

test("confidence: an open hypothesis's verdict distinguishes verified/contested/neither", () => {
  assert.strictEqual(confidenceScore({ status: "open", verdict: { verified: true } }), 0.75);
  assert.strictEqual(confidenceScore({ status: "open", verdict: { contested: true } }), 0.4);
  assert.strictEqual(confidenceScore({ status: "open", verdict: {} }), 0.25);
});

test("combined score: each axis is independently inspectable, not collapsed silently", () => {
  const axes = { semanticRelevance: 1, temporalFit: 1, sourceQuality: 1, confidence: 1 };
  assert.strictEqual(combinedScore(axes), 1, "all-perfect axes must combine to a perfect score");
  assert.strictEqual(
    combinedScore({ semanticRelevance: 0, temporalFit: 0, sourceQuality: 0, confidence: 0 }),
    0
  );
  // Weights are named and overridable, not baked into the formula.
  const customWeights = { semanticRelevance: 1, temporalFit: 0, sourceQuality: 0, confidence: 0 };
  assert.strictEqual(combinedScore({ semanticRelevance: 0.5, temporalFit: 0, sourceQuality: 0, confidence: 0 }, customWeights), 0.5);
  assert.ok(Object.keys(DEFAULT_WEIGHTS).length === 4);
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error(`  ${err.message}`);
  }
}

console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures > 0 ? 1 : 0);
