// Temporal reflection — reasons over how kenmerken evolved over time
// (validFrom/validTo/temporalText, supersession via vervangenDoor).
const express = require("express");
const { pool } = require("../../../db");
const { embed } = require("../../../embedding");
const { getOrCreateInstelling, computePromotion } = require("../../../personaHelper");
const { consolidateKenmerken } = require("../../../jobs");
const { assertStatusChangeAllowed } = require("../../../statusPromotion");

const router = express.Router();

// POST /api/persona/reflectie
router.post("/reflectie", async (req, res) => {
  const { creations = [], updates = [] } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tempIdToUuid = {};
    const createdRows = [];

    // 1. Process creations
    for (const c of creations) {
      // LLM-produced (AIService.reflectTemporalBeliefs) — a required field can be
      // missing from a hallucinated/malformed entry, and this whole loop shares one
      // transaction, so an un-validated bad row would take every other valid
      // creation/update in the same batch down with it via ROLLBACK. Skip just the
      // bad one instead.
      if (typeof c.kenmerk !== "string" || !c.kenmerk.trim()) {
        console.error("Temporal reflection: skipping creation with missing/empty kenmerk:", c);
        continue;
      }

      const soortValue = c.soort === "feit" ? "feit" : "patroon";
      const instelling = await getOrCreateInstelling();
      const { zekerheid, status } = computePromotion(
        [c.bronObjectId],
        instelling.promotie_min_bronnen,
        "observation",
        soortValue
      );

      let embeddingLiteral = null;
      try {
        embeddingLiteral = `[${(await embed(c.kenmerk)).join(",")}]`;
      } catch (err) {
        console.error("Embedding generation failed in reflect creation:", err.message);
      }

      const { rows } = await client.query(
        `INSERT INTO persona_kenmerk (k
enmerk, bron_object_ids, zekerheid, status, soort, gevoelig, embedding, valid_from, temporal_text)
         VALUES ($1, ARRAY[$2], $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          c.kenmerk,
          c.bronObjectId,
          zekerheid,
          status,
          soortValue,
          !!c.gevoelig,
          embeddingLiteral,
          c.validFrom || null,
          c.temporalText || null
        ]
      );

      const createdObj = rows[0];
      createdRows.push(createdObj);
      if (c.temporaryId) {
        tempIdToUuid[c.temporaryId] = createdObj.id;
      }
    }

    // 2. Process updates
    for (const u of updates) {
      let vervangenDoorUuid = u.vervangenDoor || null;
      if (u.vervangenByTemporaryId && tempIdToUuid[u.vervangenByTemporaryId]) {
        vervangenDoorUuid = tempIdToUuid[u.vervangenByTemporaryId];
      }

      // Chronicle Manifest V6 §5: a rejected record can never be silently
      // promoted. u.status here is caller-supplied, so this is exactly the
      // kind of write the centralized guard exists for.
      if (u.status !== undefined) {
        await assertStatusChangeAllowed(client, "persona_kenmerk", u.id, u.status);
      }

      // Build fields dynamically
      const fields = [];
      const values = [];
      let idx = 1;

      if (u.validTo !== undefined) {
        fields.push(`valid_to = $${idx++}`);
        values.push(u.validTo);
      }
      if (u.temporalText !== undefined) {
        fields.push(`temporal_text = $${idx++}`);
        values.push(u.temporalText);
      }
      if (u.status !== undefined) {
        fields.push(`status = $${idx++}`);
        values.push(u.status);
      }
      if (u.verwerpReden !== undefined) {
        fields.push(`verwerp_reden = $${idx++}`);
        values.push(u.verwerpReden);
      }
      if (vervangenDoorUuid !== null) {
        fields.push(`vervangen_door = $${idx++}`);
        values.push(vervangenDoorUuid);
      }

      if (fields.length > 0) {
        field
s.push(`laatst_versterkt_op = now()`);
        values.push(u.id); // for WHERE id = $idx
        const query = `UPDATE persona_kenmerk SET ${fields.join(", ")} WHERE id = $${idx}`;
        await client.query(query, values);
      }
    }

    await client.query("COMMIT");

    // Trigger consolidator to clean up any immediate overlaps
    consolidateKenmerken().catch((err) => console.error("[Consolidator] Immediate reflect consolidator failed:", err.message));

    res.json({ success: true, created: createdRows });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Temporal reflection transaction failed:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
