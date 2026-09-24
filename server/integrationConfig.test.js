// Plain Node, assert-based — same convention as hindsightSync.test.js.
// integrationConfig.js is geparametriseerd met een pool-arg: db-toegang
// gaat er als dep in. `node integrationConfig.test.js`.

const assert = require("assert");
const { getIntegrationConfig, updateIntegrationConfig, maskConfigForUi, CONFIG_ROW_ID } = require("./integrationConfig");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function mockPool({ row = null, failOnRead = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      if (failOnRead) throw new Error("db onbereikbaar");
      if (text.startsWith("SELECT * FROM integration_config")) return { rows: row ? [row] : [] };
      if (text.startsWith("INSERT INTO integration_config")) return { rows: row ? [row] : [] };
      if (text.startsWith("UPDATE integration_config")) return { rows: [{}] };
      return { rows: [] };
    },
  };
}

const ENV_KEYS = ["HINDSIGHT_URL", "HINDSIGHT_BANK_ID", "REFLECTION_LLM_BASE_URL", "REFLECTION_LLM_MODEL", "REFLECTION_LLM_API_KEY"];
async function withCleanEnv(env, fn) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test("getIntegrationConfig: lege DB + lege env → alles null", async () => {
  await withCleanEnv({}, async () => {
    const pool = mockPool({ row: {} });
    const config = await getIntegrationConfig({ pool });
    assert.strictEqual(config.hindsightUrl, null);
    assert.strictEqual(config.reflectionLlmApiKey, null);
  });
});

test("getIntegrationConfig: DB-veld wint van env", async () => {
  await withCleanEnv({ HINDSIGHT_URL: "http://env:1" }, async () => {
    const pool = mockPool({ row: { hindsight_url: "http://db:2" } });
    const config = await getIntegrationConfig({ pool });
    assert.strictEqual(config.hindsightUrl, "http://db:2");
  });
});

test("getIntegrationConfig: lege string in DB valt terug op env", async () => {
  await withCleanEnv({ HINDSIGHT_URL: "http://env:1" }, async () => {
    const pool = mockPool({ row: { hindsight_url: "" } });
    const config = await getIntegrationConfig({ pool });
    assert.strictEqual(config.hindsightUrl, "http://env:1");
  });
});

test("getIntegrationConfig: db-fout → env-configuratie geldt, geen throw", async () => {
  await withCleanEnv({ REFLECTION_LLM_MODEL: "mistral-small-latest" }, async () => {
    const pool = mockPool({ failOnRead: true });
    const config = await getIntegrationConfig({ pool });
    assert.strictEqual(config.reflectionLlmModel, "mistral-small-latest");
  });
});

test("updateIntegrationConfig: lege string wordt null (terug naar env)", async () => {
  const pool = mockPool({ row: {} });
  await updateIntegrationConfig({ hindsightUrl: "" }, { pool });
  const update = pool.calls.find((c) => c.text.startsWith("UPDATE integration_config"));
  assert.ok(update, "UPDATE uitgevoerd");
  assert.strictEqual(update.values[0], null);
});

test("updateIntegrationConfig: alleen meegegeven velden in de UPDATE", async () => {
  const pool = mockPool({ row: {} });
  await updateIntegrationConfig({ reflectionLlmModel: "qwen3:8b" }, { pool });
  const update = pool.calls.find((c) => c.text.startsWith("UPDATE integration_config"));
  assert.ok(update.text.includes("reflection_llm_model"));
  assert.ok(!update.text.includes("hindsight_url"));
  assert.strictEqual(update.values[0], "qwen3:8b");
});

test("updateIntegrationConfig: patch zonder bekende velden → alleen lezen", async () => {
  const pool = mockPool({ row: {} });
  await updateIntegrationConfig({}, { pool });
  assert.ok(!pool.calls.some((c) => c.text.startsWith("UPDATE integration_config")));
});

test("updateIntegrationConfig: niet-string waarde → TypeError", async () => {
  const pool = mockPool({ row: {} });
  await assert.rejects(
    () => updateIntegrationConfig({ hindsightUrl: 42 }, { pool }),
    TypeError
  );
});

test("maskConfigForUi: api-key nooit in plaintext, wel een set-vlag", () => {
  const masked = maskConfigForUi({
    hindsightUrl: "http://db:2",
    hindsightBankId: null,
    reflectionLlmBaseUrl: null,
    reflectionLlmModel: null,
    reflectionLlmApiKey: "supergeheim",
  });
  assert.strictEqual(masked.reflectionLlmApiKey, null);
  assert.strictEqual(masked.reflectionLlmApiKeySet, true);
  assert.strictEqual(masked.hindsightUrl, "http://db:2");
});

test("CONFIG_ROW_ID is de vaste singleton-id (…003, na de twee watermerken)", () => {
  assert.strictEqual(CONFIG_ROW_ID, "00000000-0000-0000-0000-000000000003");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`PASS: ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL: ${t.name}\n  ${err.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests geslaagd`);
  process.exit(failed ? 1 : 0);
})();
