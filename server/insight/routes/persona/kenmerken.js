// Kenmerken CRUD, vector-based deduplication, and the "heropstanding"
// (resurrection) logic for previously mens-rejected patterns with new evidence.
const express = require("express");
const { pool } = require("../../../db");
const { embed } = require("../../../embedding");
const { getOrCreateInstelling, computePromotion } = require("../../../personaHelper");
const { consolidateKenmerken } = require("../../../jobs");
const { assertStatusChangeAllowed } = require("../../../statusPromotion");

const router = express.Router();

// GET /api/persona/kenmerken
router.get("/kenmerken", async (req, res) => {
  const status = req.query.status;
  let query = "SELECT * FROM persona_kenmerk WHERE status != 'rejected' ORDER BY zekerheid DESC, created_at DESC";
  if (status === "rejected") {
    query = "SELECT * FROM persona_kenmerk WHERE status = 'rejected' ORDER BY created_at DESC";
  } else if (req.query.all === "true" || status === "all") {
    query = "SELECT * FROM persona_kenmerk ORDER BY zekerheid DESC, created_at DESC";
  }
  const { rows } = await pool.query(query);
  res.json(rows);
});

// POST /api/persona/kenmerken/relevant — non-rejected kenmerken semantically
// close to the given texts (recently captured temporal objects), for
// personaSync.js's automatic temporal reflection. Same reasoning as
// server/routes/memory.js's POST /facts/relevant: reflection needs to
// compare new material against *some* existing kenmerken, but resending
// every kenmerk on every automatic run grows the prompt unboundedly. Local
// embedding + Postgres query only — no LLM cost. The manual "Temporal
// reflection" button in PersonaDialog intentionally still does a full scan
// (fetchAlleKenmerken) — this endpoint is only for the recurring automatic
// path, where cost actually accumulates. Registered before POST /kenmerken
// so the literal "/relevant" segment isn't swallowed by :id-style matching.
router.post("/kenmerken/relevant", async (req, res) => {
  const { texts, limit } = req.body || {};
  if (!Array.isArray(texts) || texts.length === 0) {
    return res.status(400).json({ error: "texts (non-empty array) required" });
  }
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
      `SELECT *, 1 - (embedding <=> $1) AS semantic_relevance
       FROM persona_kenmerk
       WHERE embedding IS NOT NULL AND status != 'rejected'
       ORDER BY embedding <=> $1
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

// POST /api/persona/kenmerken
router.post("/kenmerken", async (req, res) => {
  const { kenmerk, bronObjectId, soort, gevoelig, categorie } = req.body || {};
  if (!kenmerk || !bronObjectId) return res.status(400).json({ error: "kenmerk and bronObjectId required" });
  // "algemeen" (a fact/concept from content, not a claim about the owner)
  // has no soort — that field is only meaningful for categorie "persona".
  const categorieValue = categorie === "algemeen" || categorie === "skill" ? categorie : "persona";
  const soortValue = categorieValue === "algemeen" ? null : (soort === "feit" ? "feit" : "patroon");

  // 1. Generate local embedding
  let embeddingLiteral = null;
  try {
    embeddingLiteral = `[${(await embed(kenmerk)).join(",")}]`;
  } catch (err) {
    console.error("local embedding failed, saving kenmerk without one:", err.message);
  }

  // 2. Perform vector duplicate detection if embedding is available
  // Scoped to the same categorie — an "algemeen" fact about e.g. a WordPress
  // plugin must never reinforce or merge into a "persona" trait just because
  // their embeddings happen to be similar; the two are different kinds of
  // record entirely, only sharing a table for storage convenience.
  if (embeddingLiteral) {
    try {
      const { rows: matches } = await pool.query(
        `SELECT *, 1 - (embedding <=> $1) AS similarity
         FROM persona_kenmerk
         WHERE embedding IS NOT NULL AND status != 'rejected' AND categorie = $2
         ORDER BY embedding <=> $1
         LIMIT 1`,
        [embeddingLiteral, categorieValue]
      );
      const bestMatch = matches[0];
      if (bestMatch && bestMatch.similarity > 0.82) {
        // High similarity: Reinforce the matched trait
        const bronObjectIds = bestMatch.bron_object_ids.includes(bronObjectId)
          ? bestMatch.bron_object_ids
          : [...bestMatch.bron_object_ids, bronObjectId];
        const instelling = await getOrCreateInstelling();
        const { zekerheid, status } = computePromotion(
          bronObjectIds,
          instelling.promotie_min_bronnen,
          bestMatch.status,
          bestMatch.soort,
          bestMatch.categorie
        );
        const { rows } = await pool.query(
          `UPDATE persona_kenmerk SET bron_object_ids = $1, zekerheid = $2, status = $3, laatst_versterkt_op = now()
           WHERE id = $4 RETURNING *`,
          [bronObjectIds, zekerheid, status, bestMatch.id]
        );
        return res.status(200).json({ ...rows[0], reinforced: true });
      }
    } catch (err) {
      console.error("Server-side duplicate detection failed:", err.message);
    }
  }

  // 2b. No active match — check for a mens-rejected pattern that might be
  // resurrecting with new evidence (Manifest §5, "Heropstanding"). A
  // consolidatie-rejectie never resurrects on its own (it lives on in its
  // survivor, verwerp_bron != 'mens' excludes those); only a mens-rejectie's
  // *conclusion* can be revisited, and only given a source it hasn't seen
  // before — the same evidence recurring isn't a new aanleiding.
  if (embeddingLiteral) {
    try {
      const { rows: rejectedMatches } = await pool.query(
        `SELECT *, 1 - (embedding <=> $1) AS similarity
         FROM persona_kenmerk
         WHERE embedding IS NOT NULL AND status = 'rejected' AND verwerp_bron = 'mens' AND categorie = $2
         ORDER BY embedding <=> $1
         LIMIT 1`,
        [embeddingLiteral, categorieValue]
      );
      const rejectedMatch = rejectedMatches[0];
      if (rejectedMatch && rejectedMatch.similarity > 0.82 && !rejectedMatch.bron_object_ids.includes(bronObjectId)) {
        // Prior evidence keeps counting (Manifest: "het eerdere bewijs
        // blijft daarbij meetellen") — only the aanleiding needs to be new,
        // not the whole evidence base. Always "hypothesis" (never re-enters
        // as a bare observation) and always gevoelig, regardless of the
        // original soort/gevoelig — same "never usable on zekerheid alone"
        // bar as any personality judgment, per §5's "Heropstanding krijgt
        // geen eigen status".
        const mergedBronObjectIds = [...rejectedMatch.bron_object_ids, bronObjectId];
        const instelling = await getOrCreateInstelling();
        const { zekerheid } = computePromotion(
          mergedBronObjectIds,
          instelling.promotie_min_bronnen,
          "hypothesis",
          rejectedMatch.soort,
          rejectedMatch.categorie
        );
        const { rows } = await pool.query(
          `INSERT INTO persona_kenmerk
             (kenmerk, categorie, bron_object_ids, zekerheid, status, soort, gevoelig, embedding, voorganger_id)
           VALUES ($1, $2, $3, $4, 'hypothesis', $5, true, $6, $7) RETURNING *`,
          [rejectedMatch.kenmerk, rejectedMatch.categorie, mergedBronObjectIds, zekerheid, rejectedMatch.soort, embeddingLiteral, rejectedMatch.id]
        );
        return res.status(201).json({ ...rows[0], resurrected: true });
      }
    } catch (err) {
      console.error("Resurrection check failed:", err.message);
    }
  }

  // 3. No match found or embedding failed: Create a new observation/fact
  const instelling = await getOrCreateInstelling();
  const { zekerheid, status } = computePromotion(
    [bronObjectId],
    instelling.promotie_min_bronnen,
    "observation",
    soortValue,
    categorieValue
  );

  const { rows } = await pool.query(
    `INSERT INTO persona_kenmerk (kenmerk, categorie, bron_object_ids, zekerheid, status, soort, gevoelig, embedding)
     VALUES ($1, $2, ARRAY[$3], $4, $5, $6, $7, $8) RETURNING *`,
    [kenmerk, categorieValue, bronObjectId, zekerheid, status, soortValue, !!gevoelig, embeddingLiteral]
  );

  // Trigger consolidator in the background to handle instant duplicate merging
  consolidateKenmerken().catch((err) => console.error("[Consolidator] Immediate consolidator failed:", err.message));

  res.status(201).json({ ...rows[0], reinforced: false });
});

// GET /api/persona/kenmerken/:id/vergelijkbaar
router.get("/kenmerken/:id/vergelijkbaar", async (req, res) => {
  const { rows: cur } = await pool.query("SELECT embedding FROM persona_kenmerk WHERE id = $1", [req.params.id]);
  if (!cur[0]) return res.status(404).json({ error: "not found" });
  if (!cur[0].embedding) return res.status(409).json({ error: "kenmerk has no embedding yet" });
  const { rows } = await pool.query(
    `SELECT id, kenmerk, soort, zekerheid, status, 1 - (embedding <=> $1) AS gelijkenis
     FROM persona_kenmerk
     WHERE id != $2 AND embedding IS NOT NULL AND status != 'rejected'
     ORDER BY embedding <=> $1
     LIMIT 5`,
    [cur[0].embedding, req.params.id]
  );
  res.json(rows);
});

// PATCH /api/persona/kenmerken/:id/versterk
router.patch("/kenmerken/:id/versterk", async (req, res) => {
  const { bronObjectId } = req.body || {};
  if (!bronObjectId) return res.status(400).json({ error: "bronObjectId required" });
  const { rows: existingRows } = await pool.query("SELECT * FROM persona_kenmerk WHERE id = $1", [req.params.id]);
  const kenmerk = existingRows[0];
  if (!kenmerk) return res.status(404).json({ error: "not found" });
  const bronObjectIds = kenmerk.bron_object_ids.includes(bronObjectId)
    ? kenmerk.bron_object_ids
    : [...kenmerk.bron_object_ids, bronObjectId];
  const instelling = await getOrCreateInstelling();
  const { zekerheid, status } = computePromotion(
    bronObjectIds,
    instelling.promotie_min_bronnen,
    kenmerk.status,
    kenmerk.soort,
    kenmerk.categorie
  );
  try {
    await assertStatusChangeAllowed(pool, "persona_kenmerk", req.params.id, status);
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }

  // Auto-heal embedding if it is null
  let embeddingLiteral = kenmerk.embedding;
  if (!embeddingLiteral) {
    try {
      embeddingLiteral = `[${(await embed(kenmerk.kenmerk)).join(",")}]`;
    } catch (err) {
      console.error("[Auto-Heal] local embedding failed in versterk:", err.message);
    }
  }

  const { rows } = await pool.query(
    `UPDATE persona_kenmerk 
     SET bron_object_ids = $1, zekerheid = $2, status = $3, laatst_versterkt_op = now(), embedding = COALESCE(embedding, $4)
     WHERE id = $5 RETURNING *`,
    [bronObjectIds, zekerheid, status, embeddingLiteral, req.params.id]
  );
  res.json(rows[0]);
});

// PATCH /api/persona/kenmerken/:id/bevestigen
router.patch("/kenmerken/:id/bevestigen", async (req, res) => {
  try {
    await assertStatusChangeAllowed(pool, "persona_kenmerk", req.params.id, "confirmed");
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
  const { rows } = await pool.query(
    `UPDATE persona_kenmerk SET status = 'confirmed', zekerheid = 100, laatst_versterkt_op = now()
     WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

// PATCH /api/persona/kenmerken/:id/verwerpen
router.patch("/kenmerken/:id/verwerpen", async (req, res) => {
  const { reden } = req.body || {};
  try {
    await assertStatusChangeAllowed(pool, "persona_kenmerk", req.params.id, "rejected");
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
  const { rows } = await pool.query(
    "UPDATE persona_kenmerk SET status = 'rejected', verwerp_reden = $1, verwerp_bron = 'mens' WHERE id = $2 RETURNING *",
    [reden || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

// PATCH /api/persona/kenmerken/:id/samenvoegen
router.patch("/kenmerken/:id/samenvoegen", async (req, res) => {
  const { winnaarId, reden } = req.body || {};
  if (!winnaarId || !reden) return res.status(400).json({ error: "winnaarId and reden required" });
  if (winnaarId === req.params.id) return res.status(400).json({ error: "kenmerk cannot merge into itself" });

  const { rows: loserRows } = await pool.query("SELECT * FROM persona_kenmerk WHERE id = $1", [req.params.id]);
  const loser = loserRows[0];
  if (!loser) return res.status(404).json({ error: "not found" });

  const { rows: winnerRows } = await pool.query("SELECT * FROM persona_kenmerk WHERE id = $1", [winnaarId]);
  const winner = winnerRows[0];
  if (!winner) return res.status(404).json({ error: "winnaar not found" });

  const mergedBronIds = Array.from(new Set([...winner.bron_object_ids, ...loser.bron_object_ids]));
  const instelling = await getOrCreateInstelling();
  const { zekerheid, status } = computePromotion(
    mergedBronIds,
    instelling.promotie_min_bronnen,
    winner.status,
    winner.soort,
    winner.categorie
  );

  try {
    await assertStatusChangeAllowed(pool, "persona_kenmerk", req.params.id, "rejected");
    await assertStatusChangeAllowed(pool, "persona_kenmerk", winnaarId, status);
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }

  const { rows: updatedWinnerRows } = await pool.query(
    `UPDATE persona_kenmerk SET bron_object_ids = $1, zekerheid = $2, status = $3, laatst_versterkt_op = now()
     WHERE id = $4 RETURNING *`,
    [mergedBronIds, zekerheid, status, winnaarId]
  );

  const { rows: loserUpdatedRows } = await pool.query(
    `UPDATE persona_kenmerk SET status = 'rejected', vervangen_door = $1, verwerp_reden = $2, verwerp_bron = 'consolidatie'
     WHERE id = $3 RETURNING *`,
    [winnaarId, reden, req.params.id]
  );

  res.json({ winnaar: updatedWinnerRows[0], verliezer: loserUpdatedRows[0] });
});

// POST /api/persona/kenmerken/:id/gebruik
router.post("/kenmerken/:id/gebruik", async (req, res) => {
  const { objectId, context } = req.body || {};
  if (!objectId || !context) return res.status(400).json({ error: "objectId and context required" });
  const { rows } = await pool.query(
    "INSERT INTO persona_kenmerk_gebruik (kenmerk_id, gebruikt_in_object_id, context) VALUES ($1, $2, $3) RETURNING *",
    [req.params.id, objectId, context]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
