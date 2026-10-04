// Routes voor UI-beheer van de twee achtergrondintegraties (Hindsight-pijp,
// reflectie-engine). Draaien in het memory-proces — daar leven de jobs — en
// worden via de bestaande /api/settings/integrations-proxy in server/index.js
// bereikbaar. Zelfde auth-posture als de rest van de memory-routes: het
// memory-proces luistert alleen op loopback en de capture-proxy is de enige
// caller.

const express = require("express");
const { getIntegrationConfig, updateIntegrationConfig, maskConfigForUi } = require("../integrationConfig");
const { pool } = require("../db");

const router = express.Router();

// GET /api/settings/integrations — effectieve (gemaskeerde) configuratie.
router.get("/", async (req, res) => {
  try {
    const config = await getIntegrationConfig();
    const hindsightActive = Boolean(config.hindsightUrl && config.hindsightBankId);
    const reflectionActive = Boolean(
      config.reflectionLlmApiKey && config.reflectionLlmBaseUrl && config.reflectionLlmModel
    );
    const status = { hindsight: { active: hindsightActive }, reflection: { active: reflectionActive } };
    try {
      const { rows } = await pool.query(
        "SELECT last_fact_created_at FROM hindsight_progress LIMIT 1"
      );
      status.hindsight.lastRun = rows[0]?.last_fact_created_at || null;
    } catch (_) {}
    try {
      const { rows } = await pool.query(
        "SELECT last_episode_captured_at FROM reflection_progress LIMIT 1"
      );
      status.reflection.lastRun = rows[0]?.last_episode_captured_at || null;
    } catch (_) {}
    res.json({ config: maskConfigForUi(config), status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/settings/integrations — velden bijwerken (leeg = terug naar env).
router.patch("/", async (req, res) => {
  try {
    const patch = req.body || {};
    const forbidden = Object.keys(patch).filter(
      (k) => !["hindsightUrl", "hindsightBankId", "reflectionLlmBaseUrl", "reflectionLlmModel", "reflectionLlmApiKey"].includes(k)
    );
    if (forbidden.length) return res.status(400).json({ error: `unknown fields: ${forbidden.join(", ")}` });
    await updateIntegrationConfig(patch);
    const config = await getIntegrationConfig();
    res.json({ config: maskConfigForUi(config) });
  } catch (err) {
    if (err instanceof TypeError) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/integrations/hindsight/run — UITGESCHAKELD: Foundation
// sync't niet meer naar de gedeelde Hindsight-bank (zie jobs.js). Bewust 410
// (niet verwijderd), zodat een oude UI-knop een verklaarbare fout krijgt in
// plaats van stil te falen.
router.post("/hindsight/run", async (req, res) => {
  return res.status(410).json({ error: "Hindsight-pijp is uitgeschakeld: Foundation sync't niet naar de gedeelde bank" });
});

// POST /api/settings/integrations/reflection/run — UITGESCHAKELD: zelfde reden
// als hierboven (reflectie-engine draait niet meer). Bewust 410.
router.post("/reflection/run", async (req, res) => {
  return res.status(410).json({ error: "Reflectie-engine is uitgeschakeld in Foundation" });
});

module.exports = router;
