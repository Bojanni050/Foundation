import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// Chronicle Manifest V6 §5. "interpretation" sits between raw observation and
// hypothesis (Chronicle's own first analytical structuring of an observation,
// before it's repeated enough to become a hypothesis) — not yet wired into
// any pipeline, added for forward compatibility per the manifest's five-value
// vocabulary; existing code only ever produces observation/hypothesis/
// confirmed/rejected today.
export const statusMarkeringEnum = pgEnum("status_markering", [
  "observation",
  "interpretation",
  "hypothesis",
  "confirmed",
  "rejected",
]);

// Manifest §5: a rejected record's re-eligibility depends fundamentally on
// *why* it was rejected — a consolidatie-rejectie is permanently absorbed
// into its survivor (vervangen_door) and must never resurrect on its own;
// a mens-rejectie is a rejected conclusion, not rejected evidence, and can
// be revisited given a genuinely new source (see voorganger_id below).
export const verwerpBronEnum = pgEnum("verwerp_bron", ["consolidatie", "mens"]);

// A "feit" is stated once and is simply true (e.g. "ogen zijn bruin") — it
// never needs the bronnen-promotion math. A "patroon" is inferred from
// repeated behavior (e.g. "schrijft graag 's avonds") and only becomes
// load-bearing once it recurs across independent sources. Only meaningful
// for categorie "persona" — left unset for "skill"/"algemeen".
export const soortKenmerkEnum = pgEnum("soort_kenmerk", ["feit", "patroon"]);

// persona / skill / algemeen are not three separate things — they're three
// categories of the same underlying concept (a piece of extracted knowledge,
// evidenced by objects, moving through the same observation→hypothesis→
// confirmed→rejected ladder). "persona" = a claim about the owner. "skill" =
// a reusable procedure/workflow picked up on. "algemeen" = a fact or
// concept from content that isn't about the owner at all. Consolidation and
// resurrection only ever compare within the same categorie — a persona trait
// never merges with a general fact just because the text happens to overlap.
export const categorieEnum = pgEnum("categorie", ["persona", "skill", "algemeen"]);

// Cross-object memory layer, analogous to SongCompanion's maker_memory. Lives
// outside the IndexedDB ObjectRepository contract on purpose: a kennis-item
// is not itself an "object" of the app, it's inferred context extracted from
// objects.
//
// NOTE: exported as `kennis` (the corrected mental model — persona/skill/
// algemeen are categories of one thing, not three things), but the physical
// SQL table name stays "persona_kenmerk" — renaming the physical table
// requires drizzle-kit's interactive rename-resolution prompt, which needs a
// real TTY this environment doesn't have. The JS/TS name is what the rest of
// the codebase should read as truth; the SQL name is a historical artifact.
export const kennis = pgTable("persona_kenmerk", {
  id: uuid("id").primaryKey().defaultRandom(),
  categorie: categorieEnum("categorie").notNull().default("persona"),
  kenmerk: text("kenmerk").notNull(),
  // Only meaningful for categorie "persona" — null for "skill"/"algemeen".
  soort: soortKenmerkEnum("soort"),
  // Personality-judgment-style patronen (e.g. "ongeduldig") — never counted as
  // usable just because zekerheid crossed the threshold; always needs explicit
  // confirmation first, regardless of how many sources support it. Only
  // meaningful for categorie "persona".
  gevoelig: boolean("gevoelig").notNull().default(false),
  // 0-100, same scale as maker_memory.zekerheid — makes the confidence-threshold
  // promotion logic possible. Always 100 for soort "feit" and for "algemeen"
  // (a fact doesn't get truer by repetition, so it starts fully-weighted —
  // still subject to rejection, just not to the bronnen-count ladder).
  zekerheid: integer("zekerheid").notNull().default(0),
  status: statusMarkeringEnum("status").notNull().default("observation"),
  // Chronicle object ids are app-generated strings ("obj_<ts>_<rand>"), not UUIDs.
  bronObjectIds: text("bron_object_ids").array().notNull().default([]),
  // Local Qwen3-Embedding-0.6B (server/embedding.js), 1024 dims — same model
  // and dimension SongCompanion settled on. Nullable: a kennis-item still saves
  // even if local embedding generation fails (model not downloaded yet, etc.),
  // same graceful-fallback philosophy as the rest of Chronicle's AI features.
  embedding: vector("embedding", { dimensions: 1024 }),
  // Merge trail — same pattern as SongCompanion's intentie_element.vervangenDoor/
  // herzieningsreden (Architecture Document 03, hfst. 62): a kennis-item rejected
  // because the consolidator merged it into a better-evidenced duplicate is
  // never deleted, only pointed at the survivor, with the reasoning kept so
  // the "why" of a consolidation stays inspectable instead of silent.
  vervangenDoor: uuid("vervangen_door"),
  verwerpReden: text("verwerp_reden"),
  // Categorisch onderscheid (Manifest §5) — nullable, alleen gezet als status = 'rejected'.
  verwerpBron: verwerpBronEnum("verwerp_bron"),
  // Zelf-referentie naar het mens-verworpen record waaruit dit record is
  // heropstaan met nieuw bewijs. Alleen gezet bij heropstanding, nooit bij
  // een gewone eerste observatie.
  voorgangerId: uuid("voorganger_id"),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validTo: timestamp("valid_to", { withTimezone: true }),
  temporalText: text("temporal_text"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  laatstVersterktOp: timestamp("laatst_versterkt_op", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Singleton settings row, same pattern as SongCompanion's maker_memory_instelling
// (uuid id, singleton enforced at the application level, not a DB constraint).
export const personaInstelling = pgTable("persona_instelling", {
  id: uuid("id").primaryKey().defaultRandom(),
  confidenceThreshold: integer("confidence_threshold").notNull().default(90),
  promotieMinBronnen: integer("promotie_min_bronnen").notNull().default(2),
  // Disposition traits (1-5, default 3 = neutral) — same three-trait concept
  // Hindsight's Reflect uses to shape how a bank interprets information,
  // rebuilt here rather than depending on their service. Feed into detection
  // and Pulse prompts, not into the promotion math itself.
  skepticism: integer("skepticism").notNull().default(3),
  literalism: integer("literalism").notNull().default(3),
  empathy: integer("empathy").notNull().default(3),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// "Mental model" cache (Hindsight-inspired, rebuilt locally): the last AI
// Pulse result, shown instantly on open instead of regenerating every time.
// Singleton — Pulse has exactly one current digest, not a history.
export const personaPulseCache = pgTable("persona_pulse_cache", {
  id: uuid("id").primaryKey().defaultRandom(),
  items: text("items").array().notNull(),
  aiUsed: boolean("ai_used").notNull().default(false),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});

// assumption_used log: every time an above-threshold kennis-item actually
// influences an AI suggestion (AI Weave, AI Pulse, auto-tagging, ...), it's
// recorded here so the influence stays inspectable instead of silent.
export const kennisGebruik = pgTable("persona_kenmerk_gebruik", {
  id: uuid("id").primaryKey().defaultRandom(),
  kenmerkId: uuid("kenmerk_id")
    .notNull()
    .references(() => kennis.id, { onDelete: "cascade" }),
  gebruiktInObjectId: text("gebruikt_in_object_id").notNull(),
  context: text("context").notNull(),
  gebruiktOp: timestamp("gebruikt_op", { withTimezone: true }).notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// Generic content-search layer — same local Qwen3-Embedding-0.6B (1024 dims)
// as persona_kenmerk. Two granularities on purpose: a chunk-level hit tells
// you "this specific part", an object-level hit tells you "this whole
// object" — different questions, both useful. Deliberately generic (not
// chat-specific): a chat object's chunks happen to be one per turn, but a
// long note could just as well be split into paragraph-sized chunks later
// with the same mechanism. objectId is plain text (Chronicle's
// app-generated "obj_<ts>_<rand>" ids from IndexedDB) — no FK, since objects
// live in IndexedDB, not Postgres.
//
// No role/type column here on purpose: which part of an object a chunk
// represents (e.g. "assistant turn" for a chat) is a parsing-time detail,
// baked into the chunk's own content (e.g. "Assistant: ...") rather than a
// column that would only make sense for one object type.
// --------------------------------------------------------------------------

// One chunk of an object's content. embedding is nullable — same
// graceful-fallback philosophy as persona_kenmerk: a chunk still saves even
// if local embedding generation fails.
export const objectChunk = pgTable("object_chunk", {
  id: uuid("id").primaryKey().defaultRandom(),
  objectId: text("object_id").notNull(),
  content: text("content").notNull(),
  orderIndex: integer("order_index").notNull(),
  embedding: vector("embedding", { dimensions: 1024 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per object — a single embedding over the whole object (title +
// full content), for "find that one object about X" style search.
export const objectEmbedding = pgTable("object_embedding", {
  objectId: text("object_id").primaryKey(),
  embedding: vector("embedding", { dimensions: 1024 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// Epistemic memory — a general hypothesis/evidence/knowledge-gap layer,
// distinct from persona_kenmerk. persona_kenmerk answers "what pattern does
// this evidence support, about the owner specifically, weighed by a single
// bronnen-count"; hypothesis/evidence answers a broader question that isn't
// owner-specific and isn't reducible to a source count: "what does this
// specific piece of evidence say, in which direction, and where exactly did
// it come from" — provenance and directionality are first-class here, not
// flattened into a bron_object_ids array.
//
// Same non-negotiable as persona_kenmerk (Manifest §5): nothing here ever
// auto-promotes. Meeting verification criteria only ever changes what
// isVerified() in epistemicPolicy.js reports — never the stored status.
// Only an explicit confirm/reject call (a human decision) writes status.
// --------------------------------------------------------------------------

export const hypothesisStatusEnum = pgEnum("hypothesis_status", [
  "open",
  "confirmed",
  "rejected",
]);

// supporting = argues for the hypothesis. contradicting = argues against it.
// contextualizing = neither — background that shapes interpretation without
// itself arguing a side (e.g. "asked in jest", "quoting someone else").
export const evidenceDirectionEnum = pgEnum("evidence_direction", [
  "supporting",
  "contradicting",
  "contextualizing",
]);

// bronsoort describes the semantic object type; sourceType records how the
// observation entered Chronicle. Keeping those axes separate avoids making
// custom object types part of a closed ingestion-channel enum.
export const episodeSourceTypeEnum = pgEnum("episode_source_type", [
  "chat-import",
  "document",
  "explicit-input",
  "system-observation",
]);

// A knowledge gap's own small lifecycle, independent of any one hypothesis.
// unknown = never looked into. not_asked = identified but no source has
// addressed it yet. known_absent = actively looked, genuinely no answer
// exists in the sources checked (a real finding, not silence). resolved =
// answered, normally via a linked hypothesis reaching "confirmed".
export const knowledgeGapStatusEnum = pgEnum("knowledge_gap_status", [
  "unknown",
  "not_asked",
  "known_absent",
  "resolved",
]);

export const hypothesis = pgTable("hypothesis", {
  id: uuid("id").primaryKey().defaultRandom(),
  hypothese: text("hypothese").notNull(),
  // What would count as verified/confirmed/rejected — written once at
  // creation so a later confirm/reject is judged against a fixed bar the
  // hypothesis itself declared, not a bar invented after the fact.
  verificatieCriteria: text("verificatie_criteria"),
  bevestigingsCriteria: text("bevestigings_criteria"),
  afwijzingsCriteria: text("afwijzings_criteria"),
  status: hypothesisStatusEnum("status").notNull().default("open"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  verwerpReden: text("verwerp_reden"),
  // Descriptive temporal scope of the claim itself (same meaning as
  // persona_kenmerk's own validFrom/validTo/temporalText) — copied onto the
  // resulting fact at confirmation, not re-derived later, since a fact can
  // never be mutated after the fact.
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validTo: timestamp("valid_to", { withTimezone: true }),
  temporalText: text("temporal_text"),
  // Set at creation (typically by the reflection pipeline, services/
  // hypothesisReflectionSync.js) when this hypothesis, if confirmed, replaces
  // an existing fact rather than standing alone. Copied onto the resulting
  // fact at confirmation — see fact.supersedesFactId below for why this
  // can't simply be computed later by mutating the old fact.
  supersedesFactId: uuid("supersedes_fact_id").references(() => fact.id, { onDelete: "restrict" }),
  // Local Qwen3-Embedding-0.6B (server/embedding.js), same model and
  // dimension as persona_kenmerk — lets POST /hypotheses check for an
  // existing similar OPEN hypothesis before creating a near-duplicate.
  // Nullable: a hypothesis still saves even if local embedding generation
  // fails, same graceful-fallback philosophy as the rest of Chronicle.
  embedding: vector("embedding", { dimensions: 1024 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// An immutable snapshot of exactly what Chronicle observed. Episodes are
// hypothesis-independent, so one frozen observation can be interpreted for
// several hypotheses without duplicating source text or provenance.
export const episode = pgTable(
  "episode",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Objects live in IndexedDB, so this is intentionally not a SQL FK.
    bronObjectId: text("bron_object_id").notNull(),
    bronsoort: text("bronsoort").notNull(),
    fragment: text("fragment").notNull(),
    spreker: text("spreker"),
    // Source/event time. Null means the source exposed no trustworthy time.
    observedAt: timestamp("observed_at", { withTimezone: true }),
    bronReferentie: text("bron_referentie"),
    conversationIdentity: text("conversation_identity"),
    sourceType: episodeSourceTypeEnum("source_type").notNull(),
    // Confidence in extraction, on a 0-100 scale; not hypothesis confidence.
    extractionConfidence: integer("extraction_confidence"),
    contextWindow: text("context_window"),
    // Hash over the observation fields above. capturedAt is excluded so an
    // exact re-observation resolves to the original immutable episode.
    observationHash: text("observation_hash").notNull(),
    // System time of first persistence and the episode's sole audit timestamp.
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("episode_observation_hash_unique").on(table.observationHash),
    check(
      "episode_extraction_confidence_range",
      sql`${table.extractionConfidence} IS NULL OR (${table.extractionConfidence} >= 0 AND ${table.extractionConfidence} <= 100)`,
    ),
  ],
);

// The thin interpretative relation: which direction one immutable episode
// points for one hypothesis. A pair is unique so it cannot be counted twice.
export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hypothesisId: uuid("hypothesis_id")
      .notNull()
      .references(() => hypothesis.id, { onDelete: "cascade" }),
    episodeId: uuid("episode_id")
      .notNull()
      .references(() => episode.id, { onDelete: "restrict" }),
    richting: evidenceDirectionEnum("richting").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("evidence_hypothesis_episode_unique").on(table.hypothesisId, table.episodeId),
  ],
);

// A confirmed hypothesis's output — a distinct, structurally separate record
// from the hypothesis that produced it, not just a status flag. A hypothesis
// can be confirmed at most once (epistemicPolicy.confirmHypothesis only ever
// runs from "open"), so one hypothesis produces at most one fact — enforced
// here too via the unique index, not just by application logic. Append-only
// like episode, for the same reason: a fact is a historical record of "this
// was confirmed, on this date" — a later doubt about it is new evidence
// against a NEW hypothesis, never a silent edit of this record.
export const fact = pgTable(
  "fact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inhoud: text("inhoud").notNull(),
    hypothesisId: uuid("hypothesis_id")
      .notNull()
      .references(() => hypothesis.id, { onDelete: "restrict" }),
    // Copied from the confirming hypothesis at creation time — never set or
    // changed afterward, since a fact row itself is never touched again.
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    temporalText: text("temporal_text"),
    // The fact this one replaces, if any — Chronicle's Hindsight-style
    // temporal reflection (services/hypothesisReflectionSync.js) proposes a
    // NEW hypothesis carrying this pointer rather than ever mutating the
    // superseded fact's own row; only becomes real once a human explicitly
    // confirms that hypothesis. Unique: a fact can be superseded by at most
    // one successor, so two competing replacement hypotheses can't both
    // succeed — the second confirm attempt hits this constraint and the
    // whole transaction (see /hypotheses/:id/confirm) rolls back cleanly.
    supersedesFactId: uuid("supersedes_fact_id").references((): AnyPgColumn => fact.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("fact_hypothesis_id_unique").on(table.hypothesisId),
    uniqueIndex("fact_supersedes_fact_id_unique").on(table.supersedesFactId),
  ],
);

export const knowledgeGap = pgTable("knowledge_gap", {
  id: uuid("id").primaryKey().defaultRandom(),
  onderwerp: text("onderwerp").notNull(),
  status: knowledgeGapStatusEnum("status").notNull().default("unknown"),
  // The hypothesis expected to resolve this gap, if one exists yet — optional,
  // a gap can be identified before any hypothesis addressing it has been formed.
  hypothesisId: uuid("hypothesis_id").references(() => hypothesis.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

