// Epistemic memory API — immutable episodes, hypotheses, their evidence
// interpretations, and knowledge gaps
// (see db/schema.ts's "Epistemic memory" section for the data model, and
// epistemicPolicy.js for every rule enforced here). This module never
// computes a status transition itself — it only ever calls into
// epistemicPolicy and persists whatever patch that returns, so the actual
// promotion/rejection/transition rules live in exactly one place.
const express = require("express");
const { pool } = require("../db");
const {
  isVerified,
  confirmHypothesis,
  buildFactFromHypothesis,
  rejectHypothesis,
  transitionKnowledgeGap,
} = require("../epistemicPolicy");
const { prepareEpisodeInput } = require("../episodePolicy");
const { embed } = require("../embedding");
const { temporalFit, sourceQualityFromEvidence, confidenceScore, combinedScore } = require("../retrievalPolicy");
const { buildMemoryExport } = require("../memoryExport");
const { restoreMemory, preflightMemoryRestore } = require("../memoryRestore");
const {
  getMemoryStorageInventory,
  getObjectIndexInventory,
  purgeDerivedMemory,
} = require("../memoryMaintenance");
const { auditMemoryIntegrity, purgeOrphanDerivedIndexes } = require("../memoryIntegrity");

const router = express.Router();

const EVIDENCE_DIRECTIONS = ["supporting", "contradicting", "contextualizing"];

// GET /api/memory/search?q=<text>&asOf=<ISO?>&limit=<n?> — semantic search
// across hypotheses and facts together, ranked on four separately-visible
// axes (server/retrievalPolicy.js) rather than one opaque score: semantic
// relevance, temporal fit, source quality, and confidence. `score` is only
// ever a default sort order — every axis stays on each result so a caller
// can re-rank by whichever one actually matters for their question, instead
// of trusting a single blended number.
//
// Facts don't carry their own embedding: fact.inhoud is copied verbatim from
// the confirming hypothesis's hypothese text (buildFactFromHypothesis), so
// the source hypothesis's embedding already represents it exactly — joining
// avoids a second embed() call and a second stored vector for identical text.
router.get("/search", async (req, res, next) => {
  const { q, asOf, limit } = req.query;
  if (!q) return res.status(400).json({ error: "q required" });
  const resultLimit = Math.min(parseInt(limit, 10) || 10, 50);
  const asOfIso = asOf || new Date().toISOString();

  let embeddingLiteral;
  try {
    embeddingLiteral = `[${(await embed(q)).join(",")}]`;
  } catch (err) {
    return res.status(503).json({ error: "local embedding unavailable: " + err.message });
  }

  try {
    const { rows: hypRows } = await pool.query(
      `SELECT *, 1 - (embedding <=> $1) AS semantic_relevance
       FROM hypothesis
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1
       LIMIT $2`,
      [embeddingLiteral, resultLimit]
    );
    const { rows: factRows } = await pool.query(
      `SELECT f.*, 1 - (h.embedding <=> $1) AS semantic_relevance
       FROM fact f
       JOIN hypothesis h ON h.id = f.hypothesis_id
       WHERE h.embedding IS NOT NULL
       ORDER BY h.embedding <=> $1
       LIMIT $2`,
      [embeddingLiteral, resultLimit]
    );
    const { rows: supersededRows } = await pool.query(
      "SELECT DISTINCT supersedes_fact_id FROM fact WHERE supersedes_fact_id IS NOT NULL"
    );
    const supersededIds = new Set(supersededRows.map((r) => r.supersedes_fact_id));

    async function evidenceFor(hypothesisId) {
      const { rows } = await pool.query(
        `SELECT e.*, to_jsonb(ep) AS episode
         FROM evidence e JOIN episode ep ON ep.id = e.episode_id
         WHERE e.hypothesis_id = $1`,
        [hypothesisId]
      );
      return rows;
    }

    const hypothesisResults = [];
    for (const hyp of hypRows) {
      const evidenceRows = await evidenceFor(hyp.id);
      const axes = {
        semanticRelevance: hyp.semantic_relevance,
        temporalFit: temporalFit(hyp, asOfIso),
        sourceQuality: sourceQualityFromEvidence(evidenceRows),
        confidence: confidenceScore({ status: hyp.status, verdict: isVerified(evidenceRows) }),
      };
      hypothesisResults.push({ kind: "hypothesis", id: hyp.id, text: hyp.hypothese, status: hyp.status, axes, score: combinedScore(axes) });
    }

    const factResults = [];
    for (const fact of factRows) {
      const evidenceRows = await evidenceFor(fact.hypothesis_id);
      const superseded = supersededIds.has(fact.id);
      const axes = {
        semanticRelevance: fact.semantic_relevance,
        temporalFit: temporalFit(fact, asOfIso),
        sourceQuality: sourceQualityFromEvidence(evidenceRows),
        confidence: confidenceScore({ status: "confirmed", superseded }),
      };
      factResults.push({ kind: "fact", id: fact.id, text: fact.inhoud, superseded, axes, score: combinedScore(axes) });
    }

    const results = [...hypothesisResults, ...factResults].sort((a, b) => b.score - a.score).slice(0, resultLimit);
    res.json({ query: q, asOf: asOfIso, results });
  } catch (err) {
    next(err);
  }
});

// GET /api/memory/export — portable PostgreSQL half of a Chronicle backup.
// The frontend combines this with IndexedDB objects, custom types, and raw
// attachment bytes before offering one versioned archive file.
router.get("/export", async (_req, res, next) => {
  try {
    res.json(await buildMemoryExport(pool));
  } catch (err) {
    next(err);
  }
});

// POST /api/memory/restore — merge one validated memory export transactionally.
// Immutable episodes are never updated or deleted: identical observations are
// reused by hash, while a genuine id collision aborts and rolls back everything.
router.post("/restore", async (req, res, next) => {
  try {
    res.json(await restoreMemory(pool, req.body));
  } catch (err) {
    if (err instanceof TypeError) return res.status(400).json({ error: err.message });
    if (/ conflict: /.test(err.message)) return res.status(409).json({ error: err.message });
    return next(err);
  }
});

router.post("/restore/preflight", async (req, res, next) => {
  try {
    res.json(await preflightMemoryRestore(pool, req.body));
  } catch (err) {
    if (err instanceof TypeError) return res.status(400).json({ error: err.message });
    if (/ conflict: /.test(err.message)) return res.status(409).json({ error: err.message });
    return next(err);
  }
});

router.get("/maintenance/storage", async (_req, res, next) => {
  try {
    res.json(await getMemoryStorageInventory(pool));
  } catch (err) {
    next(err);
  }
});

router.get("/maintenance/object-indexes", async (_req, res, next) => {
  try {
    res.json(await getObjectIndexInventory(pool));
  } catch (err) {
    next(err);
  }
});

router.post("/maintenance/purge-derived", async (req, res, next) => {
  try {
    res.json(await purgeDerivedMemory(pool, req.body?.confirmation));
  } catch (err) {
    if (err instanceof TypeError) return res.status(400).json({ error: err.message });
    return next(err);
  }
});

router.post("/maintenance/integrity-audit", async (req, res, next) => {
  try {
    res.json(await auditMemoryIntegrity(pool, req.body));
  } catch (err) {
    if (err instanceof TypeError) return res.status(400).json({ error: err.message });
    return next(err);
  }
});

router.post("/maintenance/purge-orphan-indexes", async (req, res, next) => {
  try {
    res.json(await purgeOrphanDerivedIndexes(pool, req.body));
  } catch (err) {
    if (err instanceof TypeError) return res.status(400).json({ error: err.message });
    return next(err);
  }
});

async function createOrReuseEpisode(input) {
  const episode = prepareEpisodeInput(input);
  const values = [
    episode.bronObjectId,
    episode.bronsoort,
    episode.fragment,
    episode.spreker,
    episode.observedAt,
    episode.bronReferentie,
    episode.conversationIdentity,
    episode.sourceType,
    episode.extractionConfidence,
    episode.contextWindow,
    episode.observationHash,
  ];
  const { rows } = await pool.query(
    `INSERT INTO episode
       (bron_object_id, bronsoort, fragment, spreker, observed_at, bron_referentie,
        conversation_identity, source_type, extraction_confidence, context_window, observation_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (observation_hash) DO NOTHING
     RETURNING *`,
    values,
  );
  if (rows[0]) return { episode: rows[0], reused: false };

  // A separate SELECT after ON CONFLICT also handles two concurrent writers:
  // once the insert statement returns, the winning transaction is visible.
  const { rows: existing } = await pool.query(
    "SELECT * FROM episode WHERE observation_hash = $1",
    [episode.observationHash],
  );
  if (!existing[0]) throw new Error("episode conflict resolved without a visible row");
  return { episode: existing[0], reused: true };
}

// POST /api/memory/episodes — freeze one raw observation. Exact retries are
// idempotent and return the already-captured append-only episode.
router.post("/episodes", async (req, res, next) => {
  let result;
  try {
    result = await createOrReuseEpisode(req.body || {});
  } catch (err) {
    if (err instanceof TypeError) return res.status(400).json({ error: err.message });
    return next(err);
  }
  res.status(result.reused ? 200 : 201).json({ ...result.episode, reused: result.reused });
});

// GET /api/memory/episodes/:id — immutable audit record.
router.get("/episodes/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM episode WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "episode not found" });
  res.json(rows[0]);
});

// GET /api/memory/episodes?since=ISO — recently captured observations, for
// the reflection pipeline (services/hypothesisReflectionSync.js) to scan
// against currently-active facts. Without ?since, returns everything —
// fine for small archives, but callers doing periodic reflection should
// always pass their own last-run watermark.
router.get("/episodes", async (req, res) => {
  const { since } = req.query;
  const query = since
    ? { text: "SELECT * FROM episode WHERE captured_at > $1 ORDER BY captured_at ASC", values: [since] }
    : { text: "SELECT * FROM episode ORDER BY captured_at ASC", values: [] };
  const { rows } = await pool.query(query.text, query.values);
  res.json(rows);
});

// GET /api/memory/sources/:bronObjectId/usage — read-only bridge across the
// IndexedDB/PostgreSQL boundary. The frontend uses this before deleting an
// object and to mark provenance links whose source object no longer exists.
router.get("/sources/:bronObjectId/usage", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       ep.*,
       COUNT(e.id)::int AS evidence_count,
       ARRAY_REMOVE(ARRAY_AGG(DISTINCT e.hypothesis_id), NULL) AS hypothesis_ids
     FROM episode ep
     LEFT JOIN evidence e ON e.episode_id = ep.id
     WHERE ep.bron_object_id = $1
     GROUP BY ep.id
     ORDER BY ep.captured_at ASC`,
    [req.params.bronObjectId],
  );
  const hypothesisIds = new Set(rows.flatMap((row) => row.hypothesis_ids || []));
  res.json({
    bronObjectId: req.params.bronObjectId,
    episodeCount: rows.length,
    evidenceCount: rows.reduce((sum, row) => sum + row.evidence_count, 0),
    hypothesisCount: hypothesisIds.size,
    episodes: rows,
  });
});

// GET /api/memory/hypotheses?status=open|confirmed|rejected
// Open hypotheses each carry their verdict (same read-only computation as
// GET /hypotheses/:id) so a list view can sort/triage by evidentiary state
// without an extra round-trip per row. confirmed/rejected rows skip this —
// there's no "should I confirm this" question left to help answer.
router.get("/hypotheses", async (req, res) => {
  const { status } = req.query;
  const query =
    status && ["open", "confirmed", "rejected"].includes(status)
      ? { text: "SELECT * FROM hypothesis WHERE status = $1 ORDER BY created_at DESC", values: [status] }
      : { text: "SELECT * FROM hypothesis ORDER BY created_at DESC", values: [] };
  const { rows } = await pool.query(query.text, query.values);

  const withVerdicts = await Promise.all(
    rows.map(async (hyp) => {
      if (hyp.status !== "open") return hyp;
      const { rows: evidenceRows } = await pool.query(
        `SELECT e.*, to_jsonb(ep) AS episode
         FROM evidence e JOIN episode ep ON ep.id = e.episode_id
         WHERE e.hypothesis_id = $1`,
        [hyp.id]
      );
      return { ...hyp, verdict: isVerified(evidenceRows) };
    })
  );
  res.json(withVerdicts);
});

// POST /api/memory/hypotheses
// validFrom/validTo/temporalText describe the claim's own temporal scope —
// copied onto the resulting fact at confirmation, never re-derived later.
// supersedesFactId marks this hypothesis, if confirmed, as replacing an
// existing fact (typically set by the reflection pipeline, services/
// hypothesisReflectionSync.js) — several competing hypotheses may name the
// same target; only the first one actually confirmed succeeds (see
// /hypotheses/:id/confirm), so this is deliberately not exclusive at
// creation time.
//
// Generates a local embedding and checks for an existing similar OPEN
// hypothesis first (same >0.82 threshold as kenmerken.js) — both the manual
// "New hypothesis" flow and the automatic extraction/reflection pipelines
// funnel through this one route, so this is the single place a near-
// duplicate hypothesis gets caught, regardless of where the candidate came
// from. A match returns the EXISTING hypothesis instead of inserting a new
// one; only confirmed/rejected hypotheses are excluded from matching — a
// closed hypothesis is a settled matter, not something to keep reinforcing.
router.post("/hypotheses", async (req, res) => {
  const { hypothese, verificatieCriteria, bevestigingsCriteria, afwijzingsCriteria, validFrom, validTo, temporalText, supersedesFactId } =
    req.body || {};
  if (!hypothese) return res.status(400).json({ error: "hypothese required" });
  if (supersedesFactId) {
    const { rows: factRows } = await pool.query("SELECT id FROM fact WHERE id = $1", [supersedesFactId]);
    if (!factRows[0]) return res.status(404).json({ error: "supersedesFactId does not reference an existing fact" });
  }

  let embeddingLiteral = null;
  try {
    embeddingLiteral = `[${(await embed(hypothese)).join(",")}]`;
  } catch (err) {
    console.error("local embedding failed, saving hypothesis without one:", err.message);
  }

  if (embeddingLiteral) {
    try {
      const { rows: matches } = await pool.query(
        `SELECT *, 1 - (embedding <=> $1) AS similarity
         FROM hypothesis
         WHERE embedding IS NOT NULL AND status = 'open'
         ORDER BY embedding <=> $1
         LIMIT 1`,
        [embeddingLiteral]
      );
      const bestMatch = matches[0];
      if (bestMatch && bestMatch.similarity > 0.82) {
        return res.status(200).json({ ...bestMatch, matched: true });
      }
    } catch (err) {
      console.error("Server-side hypothesis duplicate detection failed:", err.message);
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO hypothesis
       (hypothese, verificatie_criteria, bevestigings_criteria, afwijzings_criteria, valid_from, valid_to, temporal_text, supersedes_fact_id, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      hypothese,
      verificatieCriteria || null,
      bevestigingsCriteria || null,
      afwijzingsCriteria || null,
      validFrom || null,
      validTo || null,
      temporalText || null,
      supersedesFactId || null,
      embeddingLiteral,
    ]
  );
  res.status(201).json({ ...rows[0], matched: false });
});

// GET /api/memory/hypotheses/:id/vergelijkbaar — nearest open hypotheses by
// embedding similarity, same shape as kenmerken.js's own /vergelijkbaar.
router.get("/hypotheses/:id/vergelijkbaar", async (req, res) => {
  const { rows: cur } = await pool.query("SELECT embedding FROM hypothesis WHERE id = $1", [req.params.id]);
  if (!cur[0]) return res.status(404).json({ error: "not found" });
  if (!cur[0].embedding) return res.status(409).json({ error: "hypothesis has no embedding yet" });
  const { rows } = await pool.query(
    `SELECT id, hypothese, status, 1 - (embedding <=> $1) AS gelijkenis
     FROM hypothesis
     WHERE id != $2 AND embedding IS NOT NULL
     ORDER BY embedding <=> $1
     LIMIT 5`,
    [cur[0].embedding, req.params.id]
  );
  res.json(rows);
});

// GET /api/memory/hypotheses/:id — detail + evidence + the current
// (read-only, never-stored) verification verdict, plus the resulting fact
// if this hypothesis has been confirmed.
router.get("/hypotheses/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM hypothesis WHERE id = $1", [req.params.id]);
  const hyp = rows[0];
  if (!hyp) return res.status(404).json({ error: "not found" });

  const { rows: evidenceRows } = await pool.query(
    `SELECT e.*, to_jsonb(ep) AS episode
     FROM evidence e
     JOIN episode ep ON ep.id = e.episode_id
     WHERE e.hypothesis_id = $1
     ORDER BY e.created_at ASC`,
    [req.params.id]
  );
  const { rows: factRows } = await pool.query("SELECT * FROM fact WHERE hypothesis_id = $1", [req.params.id]);
  const verdict = isVerified(evidenceRows);
  res.json({ ...hyp, evidence: evidenceRows, verdict, fact: factRows[0] || null });
});

// GET /api/memory/facts?active=true — every confirmed hypothesis's
// resulting fact. ?active=true restricts to facts nothing else has
// superseded yet — the "currently effectively true" set the reflection
// pipeline scans, so it never proposes replacing an already-replaced fact.
router.get("/facts", async (req, res) => {
  const query =
    req.query.active === "true"
      ? "SELECT * FROM fact WHERE id NOT IN (SELECT supersedes_fact_id FROM fact WHERE supersedes_fact_id IS NOT NULL) ORDER BY created_at DESC"
      : "SELECT * FROM fact ORDER BY created_at DESC";
  const { rows } = await pool.query(query);
  res.json(rows);
});

// POST /api/memory/facts/relevant — active facts semantically close to the
// given texts (e.g. recently captured episode fragments), for temporal
// reflection (services/hypothesisReflectionSync.js). Reflection needs to
// compare new material against *some* existing facts to spot a contradiction
// or an update — but sending literally every active fact on every run grows
// unbounded forever. This does the same join as GET /search (fact shares its
// confirming hypothesis's embedding — buildFactFromHypothesis copies the
// text verbatim, so a second embed() call would just duplicate the vector),
// but per-text top-K, unioned and deduped, so only what's plausibly on-topic
// reaches the (paid) reflection LLM call. Purely a local embedding + Postgres
// query — no LLM cost of its own.
router.post("/facts/relevant", async (req, res) => {
  const { texts, limit } = req.body || {};
  if (!Array.isArray(texts) || texts.length === 0) {
    return res.status(400).json({ error: "texts (non-empty array) required" });
  }
  // Defensive cap — an unusually large batch of new episodes in one cycle
  // still costs at most this many local embed() calls, not unbounded.
  const boundedTexts = texts.slice(0, 50);
  const perTextLimit = Math.min(parseInt(limit, 10) || 10, 25);

  const byId = new Map();
  for (const text of boundedTexts) {
    if (!text || typeof text !== "string") continue;
    let embeddingLiteral;
    try {
      embeddingLiteral = `[${(await embed(text)).join(",")}]`;
    } catch (err) {
      return res.status(503).json({ error: "local embedding unavailable: " + err.message });
    }
    const { rows } = await pool.query(
      `SELECT f.*, 1 - (h.embedding <=> $1) AS semantic_relevance
       FROM fact f
       JOIN hypothesis h ON h.id = f.hypothesis_id
       WHERE h.embedding IS NOT NULL
         AND f.id NOT IN (SELECT supersedes_fact_id FROM fact WHERE supersedes_fact_id IS NOT NULL)
       ORDER BY h.embedding <=> $1
       LIMIT $2`,
      [embeddingLiteral, perTextLimit]
    );
    for (const row of rows) {
      const existing = byId.get(row.id);
      if (!existing || row.semantic_relevance > existing.semantic_relevance) {
        byId.set(row.id, row);
      }
    }
  }

  const merged = [...byId.values()].sort((a, b) => b.semantic_relevance - a.semantic_relevance);
  res.json(merged);
});

// POST /api/memory/hypotheses/:id/evidence — interpret one frozen episode
// for this hypothesis. Observation/provenance fields are never accepted here.
// Never touches hypothesis.status: adding evidence, however conclusive,
// is not the same act as a human confirming or rejecting the hypothesis.
router.post("/hypotheses/:id/evidence", async (req, res, next) => {
  const { richting, episodeId } = req.body || {};
  if (!EVIDENCE_DIRECTIONS.includes(richting)) {
    return res.status(400).json({ error: `richting must be one of: ${EVIDENCE_DIRECTIONS.join(", ")}` });
  }
  if (!episodeId) return res.status(400).json({ error: "episodeId required" });
  const { rows: hypRows } = await pool.query("SELECT id FROM hypothesis WHERE id = $1", [req.params.id]);
  if (!hypRows[0]) return res.status(404).json({ error: "hypothesis not found" });
  const { rows: episodeRows } = await pool.query("SELECT id FROM episode WHERE id = $1", [episodeId]);
  if (!episodeRows[0]) return res.status(404).json({ error: "episode not found" });

  try {
    const { rows } = await pool.query(
      `INSERT INTO evidence (hypothesis_id, episode_id, richting)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.params.id, episodeId, richting],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "episode already linked to this hypothesis" });
    }
    return next(err);
  }
});

// Shared core of PATCH /hypotheses/:id/confirm — factored out so the bulk
// route below can confirm several hypotheses without duplicating the
// transaction/race-handling logic. Throws an Error with a `.status` (HTTP
// status to report) on any expected failure; an unexpected error propagates
// with no `.status`, same as it would from the single-item route.
async function confirmHypothesisById(id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // FOR UPDATE: two concurrent confirms on the same hypothesis must not
    // both pass the "status is open" check before either writes.
    const { rows } = await client.query("SELECT * FROM hypothesis WHERE id = $1 FOR UPDATE", [id]);
    const hyp = rows[0];
    if (!hyp) {
      await client.query("ROLLBACK");
      throw Object.assign(new Error("not found"), { status: 404 });
    }
    let patch;
    try {
      patch = confirmHypothesis(hyp);
    } catch (err) {
      await client.query("ROLLBACK");
      throw Object.assign(new Error(err.message), { status: 409 });
    }
    const { rows: updated } = await client.query(
      "UPDATE hypothesis SET status = $1, confirmed_at = $2 WHERE id = $3 RETURNING *",
      [patch.status, patch.confirmedAt, id]
    );
    const newFact = buildFactFromHypothesis(hyp);
    let factRows;
    try {
      ({ rows: factRows } = await client.query(
        `INSERT INTO fact (inhoud, hypothesis_id, valid_from, valid_to, temporal_text, supersedes_fact_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [newFact.inhoud, id, newFact.validFrom, newFact.validTo, newFact.temporalText, newFact.supersedesFactId]
      ));
    } catch (err) {
      // A competing hypothesis already superseded the same fact first — this
      // confirmation loses the race. Roll back so the hypothesis itself
      // reverts to "open" rather than ending up confirmed with no fact to
      // show for it. Any other error propagates uncaught, same as it would
      // from the single-item route.
      if (err.code === "23505" && /fact_supersedes_fact_id_unique/.test(err.message)) {
        await client.query("ROLLBACK");
        throw Object.assign(new Error("the fact this hypothesis would supersede has already been superseded"), { status: 409 });
      }
      throw err;
    }
    await client.query("COMMIT");
    return { ...updated[0], fact: factRows[0] };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// PATCH /api/memory/hypotheses/:id/confirm — the one explicit "a human
// confirmed this" action. Deliberately ignores the current verdict: a human
// can confirm a not-yet-"verified" hypothesis (their call, their evidence
// standard) or decline to confirm a "verified" one — the computed verdict
// is advisory, never load-bearing on its own.
//
// Confirmation produces a fact — a distinct, append-only record, not just a
// status flag on the hypothesis — so both writes happen in one transaction:
// a hypothesis can never end up "confirmed" without the fact that makes that
// confirmation legible as a first-class object, or vice versa.
router.patch("/hypotheses/:id/confirm", async (req, res, next) => {
  try {
    res.json(await confirmHypothesisById(req.params.id));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Shared core of PATCH /hypotheses/:id/reject — see confirmHypothesisById
// above for why this is factored out (the bulk route below).
async function rejectHypothesisById(id, reden) {
  const { rows } = await pool.query("SELECT * FROM hypothesis WHERE id = $1", [id]);
  const hyp = rows[0];
  if (!hyp) throw Object.assign(new Error("not found"), { status: 404 });
  let patch;
  try {
    patch = rejectHypothesis(hyp, { reden });
  } catch (err) {
    const status = err.message === "rejectHypothesis: reden required" ? 400 : 409;
    throw Object.assign(new Error(err.message), { status });
  }
  const { rows: updated } = await pool.query(
    "UPDATE hypothesis SET status = $1, rejected_at = $2, verwerp_reden = $3 WHERE id = $4 RETURNING *",
    [patch.status, patch.rejectedAt, patch.verwerpReden, id]
  );
  return updated[0];
}

// PATCH /api/memory/hypotheses/:id/reject  { reden: string }
router.patch("/hypotheses/:id/reject", async (req, res, next) => {
  try {
    res.json(await rejectHypothesisById(req.params.id, req.body?.reden));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// PATCH /api/memory/hypotheses/bulk-confirm  { ids: string[] }
// Confirms each id independently — one id failing (already confirmed, lost
// a supersession race, ...) never blocks the rest. Still exactly as
// "explicit human action" as confirming one at a time: the human reviewed
// and selected every id in this list before this call was ever made: this
// route only saves them the repeated clicks, it doesn't relax the rule.
router.patch("/hypotheses/bulk-confirm", async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids (non-empty array) required" });
  const results = [];
  for (const id of ids) {
    try {
      results.push({ id, success: true, ...(await confirmHypothesisById(id)) });
    } catch (err) {
      results.push({ id, success: false, error: err.message });
    }
  }
  res.json({ results });
});

// PATCH /api/memory/hypotheses/bulk-reject  { ids: string[], reden: string }
// One shared reason for the whole batch — a human rejecting several at once
// typically has one reason ("all duplicates of an existing confirmed fact"),
// not a bespoke one per item.
router.patch("/hypotheses/bulk-reject", async (req, res) => {
  const { ids, reden } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids (non-empty array) required" });
  const results = [];
  for (const id of ids) {
    try {
      results.push({ id, success: true, hypothesis: await rejectHypothesisById(id, reden) });
    } catch (err) {
      results.push({ id, success: false, error: err.message });
    }
  }
  res.json({ results });
});

// GET /api/memory/knowledge-gaps?status=...
router.get("/knowledge-gaps", async (req, res) => {
  const { status } = req.query;
  const valid = ["unknown", "not_asked", "known_absent", "resolved"];
  const query =
    status && valid.includes(status)
      ? { text: "SELECT * FROM knowledge_gap WHERE status = $1 ORDER BY created_at DESC", values: [status] }
      : { text: "SELECT * FROM knowledge_gap ORDER BY created_at DESC", values: [] };
  const { rows } = await pool.query(query.text, query.values);
  res.json(rows);
});

// POST /api/memory/knowledge-gaps  { onderwerp, hypothesisId? }
router.post("/knowledge-gaps", async (req, res) => {
  const { onderwerp, hypothesisId } = req.body || {};
  if (!onderwerp) return res.status(400).json({ error: "onderwerp required" });
  const { rows } = await pool.query(
    "INSERT INTO knowledge_gap (onderwerp, hypothesis_id) VALUES ($1, $2) RETURNING *",
    [onderwerp, hypothesisId || null]
  );
  res.status(201).json(rows[0]);
});

// PATCH /api/memory/knowledge-gaps/:id/status  { status, hypothesisId? }
// hypothesisId is optional and only meaningful when transitioning to
// "resolved" — links the gap to whatever hypothesis actually answered it.
router.patch("/knowledge-gaps/:id/status", async (req, res) => {
  const { status, hypothesisId } = req.body || {};
  const { rows } = await pool.query("SELECT * FROM knowledge_gap WHERE id = $1", [req.params.id]);
  const gap = rows[0];
  if (!gap) return res.status(404).json({ error: "not found" });
  let patch;
  try {
    patch = transitionKnowledgeGap(gap, status);
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
  const { rows: updated } = await pool.query(
    `UPDATE knowledge_gap
     SET status = $1, resolved_at = $2, hypothesis_id = COALESCE($3, hypothesis_id)
     WHERE id = $4 RETURNING *`,
    [patch.status, patch.resolvedAt || null, hypothesisId || null, req.params.id]
  );
  res.json(updated[0]);
});

module.exports = router;
