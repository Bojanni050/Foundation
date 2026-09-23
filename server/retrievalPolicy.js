// Pure ranking layer for GET /api/memory/search. Same "no DB access, fully
// unit-testable" discipline as epistemicPolicy.js, but a different concern:
// epistemicPolicy.js guards status transitions, this module only scores.
//
// Deliberately four separate, inspectable axes rather than one opaque
// number — semantic relevance, temporal fit, source quality, and confidence
// answer different questions, and collapsing them silently would hide
// exactly the kind of judgment call a human should be able to see and
// override. combinedScore() is only ever a default sort order, never the
// only view of a result.
const DEFAULT_WEIGHTS = {
  semanticRelevance: 0.4,
  temporalFit: 0.2,
  sourceQuality: 0.2,
  confidence: 0.2,
};

// Binary, not graduated: this system never auto-decays anything (the same
// "no auto-anything" rule as everywhere else in epistemicPolicy.js), so a
// fact/hypothesis with a declared valid_from/valid_to either falls inside
// that stated window or it doesn't. No declared window at all means no
// temporal claim was ever made, so it always fits.
function temporalFit(item, asOfIso = new Date().toISOString()) {
  const validFrom = item.valid_from ?? item.validFrom ?? null;
  const validTo = item.valid_to ?? item.validTo ?? null;
  if (!validFrom && !validTo) return 1;
  const asOf = new Date(asOfIso).getTime();
  if (validFrom && asOf < new Date(validFrom).getTime()) return 0;
  if (validTo && asOf > new Date(validTo).getTime()) return 0;
  return 1;
}

// Average extraction confidence across the evidence's episodes, 0-1. 0.5
// (neutral, not penalized) when no episode declared a confidence at all —
// "unknown" is not the same as "low quality".
function sourceQualityFromEvidence(evidenceRows) {
  const confidences = evidenceRows
    .map((e) => {
      const episode = e.episode || e;
      const c = episode.extraction_confidence ?? episode.extractionConfidence;
      return typeof c === "number" ? c : null;
    })
    .filter((c) => c !== null);
  if (!confidences.length) return 0.5;
  const avg = confidences.reduce((sum, c) => sum + c, 0) / confidences.length;
  return Math.max(0, Math.min(1, avg / 100));
}

// How much this result's own status/verdict warrants trust — not whether
// it's "true", just how settled it currently is. A superseded fact scores
// lower than an active one (it WAS confirmed, but isn't the current
// understanding); a contested open hypothesis scores lower than a verified
// one, but neither is zero — an open hypothesis is still a real, tracked
// claim, not noise.
function confidenceScore({ status, verdict, superseded }) {
  if (status === "confirmed") return superseded ? 0.5 : 1;
  if (status === "rejected") return 0;
  if (verdict?.verified) return 0.75;
  if (verdict?.contested) return 0.4;
  return 0.25;
}

function combinedScore(axes, weights = DEFAULT_WEIGHTS) {
  return (
    axes.semanticRelevance * weights.semanticRelevance +
    axes.temporalFit * weights.temporalFit +
    axes.sourceQuality * weights.sourceQuality +
    axes.confidence * weights.confidence
  );
}

module.exports = {
  DEFAULT_WEIGHTS,
  temporalFit,
  sourceQualityFromEvidence,
  confidenceScore,
  combinedScore,
};
