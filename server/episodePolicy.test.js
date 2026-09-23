const assert = require("assert");
const {
  normalizeEpisodeInput,
  episodeObservationHash,
  prepareEpisodeInput,
} = require("./episodePolicy");

const base = {
  bronObjectId: "obj_1",
  bronsoort: "chat",
  fragment: "  exact source text  ",
  spreker: "user",
  observedAt: "2026-07-14T10:15:00+02:00",
  bronReferentie: "turn:4",
  conversationIdentity: "chatgpt:abc",
  sourceType: "chat-import",
  extractionConfidence: 92,
  contextWindow: "before\n  exact source text  \nafter",
};

const normalized = normalizeEpisodeInput(base);
assert.strictEqual(normalized.fragment, base.fragment, "frozen fragment whitespace must be preserved");
assert.strictEqual(normalized.observedAt, "2026-07-14T08:15:00.000Z");
assert.strictEqual(normalized.extractionConfidence, 92);

const first = prepareEpisodeInput(base);
const second = prepareEpisodeInput({ ...base });
assert.strictEqual(first.observationHash, second.observationHash, "same observation must have a stable hash");
assert.strictEqual(first.observationHash.length, 64);

const changedInterpretationIrrelevant = episodeObservationHash(normalized);
assert.strictEqual(changedInterpretationIrrelevant, first.observationHash);
assert.notStrictEqual(
  prepareEpisodeInput({ ...base, fragment: `${base.fragment}!` }).observationHash,
  first.observationHash,
  "changing the frozen observation must produce another episode",
);

assert.throws(() => prepareEpisodeInput({ ...base, sourceType: "web" }), /sourceType/);
assert.throws(() => prepareEpisodeInput({ ...base, extractionConfidence: 101 }), /0 through 100/);
assert.throws(() => prepareEpisodeInput({ ...base, observedAt: "not-a-date" }), /valid date-time/);

console.log("ok - episode normalization, validation, and identity");
