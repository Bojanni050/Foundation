// Pure policy layer for the epistemic memory tables (hypothesis/evidence/
// knowledge_gap, see db/schema.ts). No DB access here on purpose — every
// function takes plain rows/objects and returns a verdict or a patch,
// so it's fully unit-testable without Postgres (see epistemicPolicy.test.js)
// and so server/routes/memory.js stays the only place that actually writes.
//
// The one rule every function below exists to protect: meeting verification
// criteria never promotes a hypothesis by itself. isVerified() only ever
// reports whether the bar is currently met — confirmHypothesis()/
// rejectHypothesis() are the sole writers of `status`, and they only run
// when a route handler calls them in response to an explicit human action.

const DEFAULT_MIN_INDEPENDENT_SOURCES = 2;

// Source identity belongs to the immutable episode, not to the evidence link.
// API queries return that episode nested on each evidence row. Two episodes
// from one chat still count as one independent source; non-chat episodes fall
// back to their Chronicle object id.
function sourceKeyForEvidence(item) {
  const source = item.episode || item;
  const conversationIdentity = source.conversationIdentity || source.conversation_identity;
  if (conversationIdentity) return conversationIdentity;
  const bronObjectId = source.bronObjectId ?? source.bron_object_id;
  if (!bronObjectId) {
    throw new Error("sourceKeyForEvidence: joined episode provenance required");
  }
  return `object:${bronObjectId}`;
}

// Distinct source count for a list of evidence rows, all assumed to already
// be filtered to the direction the caller cares about (see isVerified below).
function countIndependentSources(evidenceItems) {
  return new Set(evidenceItems.map(sourceKeyForEvidence)).size;
}

// Groups evidence by independent source — useful for a detail view that
// wants to show "these 3 fragments are actually 1 source" rather than just
// a bare count.
function groupIndependentSources(evidenceItems) {
  const groups = new Map();
  for (const item of evidenceItems) {
    const key = sourceKeyForEvidence(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

// Reports the current evidentiary state of a hypothesis — never mutates
// anything, never touches `status`. "Verified" requires enough independent
// supporting sources AND zero unresolved contradicting sources; any
// contradicting evidence makes it "contested" instead, which a route can
// surface to the human but must never treat as grounds to auto-reject
// either — afwijzing is exactly as explicit as bevestiging.
function isVerified(evidenceItems, { minIndependentSources = DEFAULT_MIN_INDEPENDENT_SOURCES } = {}) {
  const supporting = evidenceItems.filter((e) => e.richting === "supporting");
  const contradicting = evidenceItems.filter((e) => e.richting === "contradicting");
  const independentSupportingCount = countIndependentSources(supporting);
  const independentContradictingCount = countIndependentSources(contradicting);

  const hasEnoughSupport = independentSupportingCount >= minIndependentSources;
  const contested = independentContradictingCount > 0;

  return {
    verified: hasEnoughSupport && !contested,
    contested: hasEnoughSupport && contested,
    independentSupportingCount,
    independentContradictingCount,
  };
}

function canConfirm(hypothesis) {
  return hypothesis.status === "open";
}

function canReject(hypothesis) {
  return hypothesis.status === "open";
}

// Returns the patch to apply — does not write anything itself. Throws
// rather than silently no-op'ing so a caller can't accidentally promote a
// hypothesis that isn't eligible (same "loud, not quiet" principle as
// statusPromotion.js's assertStatusChangeAllowed).
function confirmHypothesis(hypothesis) {
  if (!canConfirm(hypothesis)) {
    throw new Error(`confirmHypothesis: hypothesis ${hypothesis.id} is "${hypothesis.status}", not "open"`);
  }
  return { status: "confirmed", confirmedAt: new Date() };
}

// The fact row to insert when a hypothesis is confirmed — a pure mapping,
// not a decision, so it belongs here rather than inline in the route.
// Temporal scope and any supersession target are copied once, at this exact
// moment, because a fact can never be edited afterward (see db/schema.ts).
function buildFactFromHypothesis(hypothesis) {
  return {
    inhoud: hypothesis.hypothese,
    validFrom: hypothesis.valid_from ?? hypothesis.validFrom ?? null,
    validTo: hypothesis.valid_to ?? hypothesis.validTo ?? null,
    temporalText: hypothesis.temporal_text ?? hypothesis.temporalText ?? null,
    supersedesFactId: hypothesis.supersedes_fact_id ?? hypothesis.supersedesFactId ?? null,
  };
}

// A rejection always needs a reason — mirrors persona_kenmerk's verwerp_reden,
// the same "why" that keeps a rejection inspectable instead of a bare flag.
function rejectHypothesis(hypothesis, { reden } = {}) {
  if (!canReject(hypothesis)) {
    throw new Error(`rejectHypothesis: hypothesis ${hypothesis.id} is "${hypothesis.status}", not "open"`);
  }
  if (!reden) {
    throw new Error("rejectHypothesis: reden required");
  }
  return { status: "rejected", rejectedAt: new Date(), verwerpReden: reden };
}

// Knowledge gaps move forward through a small, deliberately non-cyclic
// lifecycle — see db/schema.ts's knowledgeGapStatusEnum comment for what
// each state means. `resolved` is terminal: a gap that's been answered
// doesn't quietly reopen just because someone raises a new doubt — that's a
// new gap, or a new hypothesis pointed at this one's resolution.
const ALLOWED_GAP_TRANSITIONS = {
  unknown: ["not_asked", "known_absent", "resolved"],
  not_asked: ["known_absent", "resolved"],
  known_absent: ["resolved"],
  resolved: [],
};

function canTransitionKnowledgeGap(fromStatus, toStatus) {
  return (ALLOWED_GAP_TRANSITIONS[fromStatus] || []).includes(toStatus);
}

// Returns the patch to apply. `resolved` should normally carry the
// hypothesisId that resolved it, but that's the caller's (route's)
// responsibility to attach — this function only enforces the transition.
function transitionKnowledgeGap(gap, toStatus) {
  if (!canTransitionKnowledgeGap(gap.status, toStatus)) {
    throw new Error(`transitionKnowledgeGap: "${gap.status}" -> "${toStatus}" is not allowed`);
  }
  const patch = { status: toStatus };
  if (toStatus === "resolved") patch.resolvedAt = new Date();
  return patch;
}

module.exports = {
  DEFAULT_MIN_INDEPENDENT_SOURCES,
  sourceKeyForEvidence,
  countIndependentSources,
  groupIndependentSources,
  isVerified,
  canConfirm,
  canReject,
  confirmHypothesis,
  buildFactFromHypothesis,
  rejectHypothesis,
  ALLOWED_GAP_TRANSITIONS,
  canTransitionKnowledgeGap,
  transitionKnowledgeGap,
};
