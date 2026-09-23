// Pulse cache endpoints — the last generated "mental model" digest.
const express = require("express");
const { pool } = require("../../../db");

const router = express.Router();

// GET /api/persona/pulse — cached digest
router.get("/pulse", async (_req, res) => {
  const { rows } = await pool.query("SELECT * FROM persona_pulse_cache ORDER BY generated_at DESC LIMIT 1");
  res.json(rows[0] || null);
});

// POST /api/persona/pulse — overwrite the cache with a freshly generated digest
router.post("/pulse", async (req, res) => {
  const { items, aiUsed } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: "items array required" });
  await pool.query("DELETE FROM persona_pulse_cache");
  const { rows } = await pool.query(
    "INSERT INTO persona_pulse_cache (items, ai_used) VALUES ($1, $2) RETURNING *",
    [items, !!aiUsed]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
