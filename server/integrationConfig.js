// UI-beheerbare configuratie voor de Hindsight-pijp en de reflectie-LLM.
// Singleton-rij integration_config (migratie 0024): elk veld nullable —
// leeg valt terug op de root-.env, zodat een bestaande env-configuratie
// blijft werken en de UI alleen override wat er expliciet ingevuld staat.
// GetIntegrationConfig levert altijd een volledig gevuld object: DB-waarde
// als die er is, anders de env-waarde, anders null.

const { pool: dbPool } = require("./db");

const CONFIG_ROW_ID = "00000000-0000-0000-0000-000000000003";

async function getOrCreateConfigRow(pool) {
  const { rows } = await pool.query(
    "SELECT * FROM integration_config WHERE id = $1",
    [CONFIG_ROW_ID]
  );
  if (rows[0]) return rows[0];
  const inserted = await pool.query(
    "INSERT INTO integration_config (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING *",
    [CONFIG_ROW_ID]
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const again = await pool.query(
    "SELECT * FROM integration_config WHERE id = $1",
    [CONFIG_ROW_ID]
  );
  return again.rows[0];
}

// Effectieve configuratie: DB-veld indien gevuld, anders env. Levert nooit
// een fout — een onbereikbare database betekent "env-configuratie geldt".
async function getIntegrationConfig({ pool: poolArg } = {}) {
  const pool = poolArg || dbPool;
  let row = null;
  try {
    row = await getOrCreateConfigRow(pool);
  } catch (err) {
    console.error("[IntegrationConfig] lezen mislukt, env-configuratie geldt:", err.message);
  }
  const db = (field) => (row && row[field] != null && row[field] !== "" ? row[field] : null);
  return {
    hindsightUrl: db("hindsight_url") || process.env.HINDSIGHT_URL || null,
    hindsightBankId: db("hindsight_bank_id") || process.env.HINDSIGHT_BANK_ID || null,
    reflectionLlmBaseUrl: db("reflection_llm_base_url") || process.env.REFLECTION_LLM_BASE_URL || null,
    reflectionLlmModel: db("reflection_llm_model") || process.env.REFLECTION_LLM_MODEL || null,
    reflectionLlmApiKey: db("reflection_llm_api_key") || process.env.REFLECTION_LLM_API_KEY || null,
  };
}

// Schrijfroute: alleen expliciet aangeleverde velden worden bijgewerkt,
// zodat de UI een enkel veld kan opslaan zonder de rest te wissen. Lege
// string betekent bewust "terug naar env" (veld op null zetten).
async function updateIntegrationConfig(patch, { pool: poolArg } = {}) {
  const pool = poolArg || dbPool;
  const allowed = {
    hindsightUrl: "hindsight_url",
    hindsightBankId: "hindsight_bank_id",
    reflectionLlmBaseUrl: "reflection_llm_base_url",
    reflectionLlmModel: "reflection_llm_model",
    reflectionLlmApiKey: "reflection_llm_api_key",
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      const v = patch[key];
      if (typeof v !== "string") throw new TypeError(`${key} must be a string`);
      values.push(v === "" ? null : v);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (sets.length === 0) return getIntegrationConfig({ pool });
  values.push(CONFIG_ROW_ID);
  await pool.query(
    `UPDATE integration_config SET ${sets.join(", ")}, updated_at = now() WHERE id = $${values.length}`,
    values
  );
  return getIntegrationConfig({ pool });
}

// Voor de UI: api-key nooit in plaintext teruggeven — alleen of er één
// geconfigureerd is en van welke bron (db of env).
function maskConfigForUi(config) {
  return {
    ...config,
    reflectionLlmApiKey: null,
    reflectionLlmApiKeySet: Boolean(config.reflectionLlmApiKey),
  };
}

module.exports = {
  getIntegrationConfig,
  updateIntegrationConfig,
  maskConfigForUi,
  CONFIG_ROW_ID,
};
