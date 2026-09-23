// Instelling (settings) endpoints — confidence threshold, promotion rules,
// and the disposition sliders (skepticism/literalism/empathy) that shape Pulse.
const express = require("express");
const { pool } = require("../../../db");
const { getOrCreateInstelling } = require("../../../personaHelper");

const router = express.Router();

// GET /api/persona/instelling
router.get("/instelling", async (_req, res) => {
  res.json(await getOrCreateInstelling());
});

// PATCH /api/persona/instelling
router.patch("/instelling", async (req, res) => {
  const current = await getOrCreateInstelling();
  const confidenceThreshold = req.body?.confidenceThreshold ?? current.confidence_threshold;
  const promotieMinBronnen = req.body?.promotieMinBronnen ?? current.promotie_min_bronnen;
  const skepticism = req.body?.skepticism ?? current.skepticism;
  const literalism = req.body?.literalism ?? current.literalism;
  const empathy = req.body?.empathy ?? current.empathy;
  const { rows } = await pool.query(
    `UPDATE persona_instelling
     SET confidence_threshold = $1, promotie_min_bronnen = $2, skepticism = $3, literalism = $4, empathy = $5, updated_at = now()
     WHERE id = $6 RETURNING *`,
    [confidenceThreshold, promotieMinBronnen, skepticism, literalism, empathy, current.id]
  );
  res.json(rows[0]);
});

module.exports = router;
