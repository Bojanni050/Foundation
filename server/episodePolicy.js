const { createHash } = require("crypto");

const EPISODE_SOURCE_TYPES = [
  "chat-import",
  "document",
  "explicit-input",
  "system-observation",
];

function optionalText(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeObservedAt(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("observedAt must be a valid date-time");
  }
  return date.toISOString();
}

// Normalization is intentionally conservative: fragment and contextWindow
// retain their exact whitespace because an episode is a frozen observation,
// not cleaned-up display text. Identifier-like fields are trimmed.
function normalizeEpisodeInput(input = {}) {
  const bronObjectId = typeof input.bronObjectId === "string" ? input.bronObjectId.trim() : "";
  const bronsoort = typeof input.bronsoort === "string" ? input.bronsoort.trim() : "";
  const fragment = typeof input.fragment === "string" ? input.fragment : "";
  const sourceType = typeof input.sourceType === "string" ? input.sourceType.trim() : "";

  if (!bronObjectId) throw new TypeError("bronObjectId required");
  if (!bronsoort) throw new TypeError("bronsoort required");
  if (!fragment.trim()) throw new TypeError("fragment required");
  if (!EPISODE_SOURCE_TYPES.includes(sourceType)) {
    throw new TypeError(`sourceType must be one of: ${EPISODE_SOURCE_TYPES.join(", ")}`);
  }

  const extractionConfidence = input.extractionConfidence;
  if (
    extractionConfidence !== undefined &&
    extractionConfidence !== null &&
    (!Number.isInteger(extractionConfidence) || extractionConfidence < 0 || extractionConfidence > 100)
  ) {
    throw new TypeError("extractionConfidence must be an integer from 0 through 100");
  }

  return {
    bronObjectId,
    bronsoort,
    fragment,
    spreker: optionalText(input.spreker),
    observedAt: normalizeObservedAt(input.observedAt),
    bronReferentie: optionalText(input.bronReferentie),
    conversationIdentity: optionalText(input.conversationIdentity),
    sourceType,
    extractionConfidence: extractionConfidence ?? null,
    contextWindow: optionalText(input.contextWindow),
  };
}

function episodeObservationHash(normalizedEpisode) {
  return createHash("sha256").update(JSON.stringify(normalizedEpisode), "utf8").digest("hex");
}

function prepareEpisodeInput(input) {
  const episode = normalizeEpisodeInput(input);
  return { ...episode, observationHash: episodeObservationHash(episode) };
}

module.exports = {
  EPISODE_SOURCE_TYPES,
  normalizeEpisodeInput,
  episodeObservationHash,
  prepareEpisodeInput,
};
