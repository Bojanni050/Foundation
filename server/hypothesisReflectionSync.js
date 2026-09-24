// De reflectie-engine (de "reflection pipeline" die routes/memory.js al
// drie keer aankondigt): scant nieuwe episodes sinds het watermerk,
// zoekt semantisch relevante actieve feiten (dezelfde join als
// POST /api/memory/facts/relevant — feiten delen de embedding van hun
// bevestigende hypothese), en laat een LLM-stap beoordelen of het nieuwe
// materiaal een bestaand feit tegenspreekt of bijwerkt.
//
// Epistemiek — de engine stelt voor, nooit meer (Manifest §5, zelfde regel
// als epistemicPolicy.js): ze schrijft uitsluitend OPEN hypotheses via
// createOrReuseHypothesis (identiek pad als de handmatige flow, incl.
// >0.82 near-duplicate-check) en linkt evidence via linkEvidence. Status
// promoveert hier nooit: confirm/reject blijft de uitsluitende daad van
// de mens via de bestaande routes. Een supersessie wordt pas echt als
// de mens de vervang-hypothese bevestigt (fact.supersedes_fact_id wordt
// pas gezet door die confirm, niet hier).
//
// Bewust incrementeel per run: hooguit MAX_PROPOSALS_PER_RUN voorstellen.
// De engine rent niet vooruit op een berg episodes — de mens moet eerst
// de vorige ronde hebben kunnen beoordelen.
const { pool: dbPool } = require("./db");
const { embed } = require("./embedding");
const memoryRouter = require("./routes/memory");
const createOrReuseHypothesis = memoryRouter.createOrReuseHypothesis;
const linkEvidence = memoryRouter.linkEvidence;

const CHECKPOINT_ID = "00000000-0000-0000-0000-000000000002";
const EPISODE_BATCH = 40;
const FACTS_PER_EPISODE = 8;
const MAX_PROPOSALS_PER_RUN = 3;
const EMBEDDING_SIMILARITY_BAR = 0.55;

// Geen reflectie-LLM geconfigureerd → geen engine. Zelfde patroon als
// hindsightClientFromEnv: bewust geen fout elke run, gewoon uit.
// Config kan expliciet meegegeven worden (UI-beheer, zie
// server/integrationConfig.js) — zonder argumenten geldt de env zoals voorheen.
function reflectorFromEnv({ fetchImpl = fetch, apiKey, baseUrl, model } = {}) {
  apiKey = apiKey || process.env.REFLECTION_LLM_API_KEY;
  baseUrl = baseUrl || process.env.REFLECTION_LLM_BASE_URL;
  model = model || process.env.REFLECTION_LLM_MODEL;
  if (!apiKey || !baseUrl || !model) return null;
  const root = String(baseUrl).replace(/\/+$/, "");
  return {
    model,
    async judge({ episodes, facts }) {
      const prompt = buildJudgePrompt(episodes, facts);
      let response;
      try {
        response = await fetchImpl(`${root}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}``,
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
              { role: "system", content: JUDGE_SYSTEM_PROMPT },
              { role: "user", content: prompt },
            ],
            response_format: { type: "json_object" },
          }),
          signal: AbortSignal.timeout(60000),
        });
      } catch (error) {
        throw new Error(`reflectie-LLM onbereikbaar: ${error.message}`);
      }
      if (!response.ok) {
        throw new Error(`reflectie-LLM antwoordde ${response.status}`);
      }
      const data = await response.json();
      return parseJudgeOutput(data.choices?.[0]?.message?.content);
    },
  };
}

const JUDGE_SYSTEM_PROMPT = `Je beoordeelt nieuwe observaties tegen bestaande, mens-bevestigde feiten.
Zoek uitsluitend naar twee dingen:
1. CONTRADICTIE: het nieuwe materiaal maakt een bestaand feit waarschijnlijk onjuist of verouderd.
2. UPDATE: het nieuwe materiaan verfijnt of vervangt een bestaand feit (bijv. een nieuwere waarde voor hetzelfde onderwerp).

Je beslist NIET of een feit klopt — de mens bevestigt of verwerpt altijd zelf.
Antwoord met uitsluitend JSON:
{"proposals": [{"type": "contradictie" | "update", "factId": "<id van het bestaande feit>",
  "hypothese": "<nieuwe hypothese als één zin>", "reden": "<waarom>",
  "evidence": [{"episodeId": "<id>", "richting": "supporting" | "contradicting" | "contextualizing"}]}]}
Zonder relevante contradictie of update: {"proposals": []}.
Richtingen: "supporting" = voor de nieuwe hypothese, "contradicting" = ertegen, "contextualizing" = context zonder kant te kiezen.`;

function buildJudgePrompt(episodes, facts) {
  const episodeLines = episodes.map((e) =>
    `- id=${e.id} (gezien ${e.observed_at ?? e.observedAt ?? "?"}, bron ${e.bronsoort}): ${e.fragment}`
  );
  const factLines = facts.map((f) => {
    const geldigheid = f.temporal_text ?? f.temporalText
      ? ` (geldigheid: ${f.temporal_text ?? f.temporalText})`
      : "";
    return `- feit id=${f.id}: ${f.inhoud}${geldigheid}`;
  });
  return [
    "Nieuwe observaties:",
    ...episodeLines,
    "",
    "Bestaande actieve feiten:",
    ...factLines,
  ].join("\n");
}

function parseJudgeOutput(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new Error("reflectie-LLM gaf geen geldige JSON");
  }
  const proposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];
  return proposals.filter((p) => p && p.factId && p.hypothese && Array.isArray(p.evidence));
}

async function findRelevantFacts(fragments, pool, embedText) {
  const byId = new Map();
  for (const fragment of fragments.slice(0, 50)) {
    let embeddingLiteral;
    try {
      embeddingLiteral = `[${(await embedText(fragment)).join(",")}]`;
    } catch (err) {
      console.error("[Reflectie] embedding onbeschikbaar:", err.message);
      return [];
    }
    const { rows } = await pool.query(
      `SELECT f.*, 1 - (h.embedding <=> $1) AS semantic_relevance
       FROM fact f
       JOIN hypothesis h ON h.id = f.hypothesis_id
       WHERE h.embedding IS NOT NULL
         AND f.id NOT IN (SELECT supersedes_fact_id FROM fact WHERE supersedes_fact_id IS NOT NULL)
       ORDER BY h.embedding <=> $1
       LIMIT $2`,
      [embeddingLiteral, FACTS_PER_EPISODE]
    );
    for (const row of rows) {
      if ((row.semantic_relevance ?? 0) < EMBEDDING_SIMILARITY_BAR) continue;
      const existing = byId.get(row.id);
      if (!existing || row.semantic_relevance > existing.semantic_relevance) {
        byId.set(row.id, row);
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.semantic_relevance - a.semantic_relevance);
}

async function runHypothesisReflectionSync({
  reflector,
  pool: poolArg,
  embed: embedArg,
  createOrReuseHypothesis: createArg,
  linkEvidence: linkArg,
  now = () => new Date(),
} = {}) {
  if (!reflector) return;
  const pool = poolArg || dbPool;
  const embedText = embedArg || embed;
  const createHypothesis = createArg || createOrReuseHypothesis;
  const link = linkArg || linkEvidence;

  const runStartedAt = now();
  let episodes = [];
  try {
    const { rows: cpRows } = await pool.query(
      "SELECT last_episode_captured_at FROM reflection_progress WHERE id = $1",
      [CHECKPOINT_ID]
    );
    const lastAt = cpRows[0] ? cpRows[0].last_episode_captured_at : null;
    const { rows } = await pool.query(
      `SELECT * FROM episode
       WHERE captured_at > COALESCE($1, to_timestamp(0))
         AND captured_at <= $2
       ORDER BY captured_at ASC
       LIMIT $3`,
      [lastAt, runStartedAt, EPISODE_BATCH]
    );
    episodes = rows;
  } catch (err) {
    console.error("[Reflectie] episode-scan mislukt:", err.message);
    return;
  }
  if (episodes.length === 0) return;

  const relevantFacts = await findRelevantFacts(
    episodes.map((e) => e.fragment),
    pool,
    embedText
  );
  if (relevantFacts.length === 0) {
    await advanceWatermark(pool, runStartedAt);
    return;
  }

  let proposals = [];
  try {
    proposals = await reflector.judge({ episodes, facts: relevantFacts });
  } catch (err) {
    // Geen watermerk: dezelfde episodes worden de volgende run opnieuw
    // beoordeeld — een transient LLM-fout verliest nooit observaties.
    console.error("[Reflectie] LLM-stap mislukt (volgende run probeert opnieuw):", err.message);
    return;
  }
  if (!Array.isArray(proposals) || proposals.length === 0) {
    await advanceWatermark(pool, runStartedAt);
    return;
  }

  let created = 0;
  for (const proposal of proposals.slice(0, MAX_PROPOSALS_PER_RUN)) {
    try {
      const { hypothesis } = await createHypothesis({
        hypothese: proposal.hypothese,
        verificatieCriteria: proposal.reden,
        supersedesFactId: proposal.type === "update" ? proposal.factId : null,
      });
      for (const ev of proposal.evidence) {
        await link({
          hypothesisId: hypothesis.id,
          episodeId: ev.episodeId,
          richting: ev.richting,
        });
      }
      created++;
      console.log(
        `[Reflectie] hypothese voorgesteld (${proposal.type}, supersedes ${proposal.type === "update" ? proposal.factId : "geen"}): ${proposal.hypothese}`
      );
    } catch (err) {
      console.error(`[Reflectie] voorstel mislukt (volgende run opnieuw):`, err.message);
      return;
    }
  }

  await advanceWatermark(pool, runStartedAt);
  console.log(`[Reflectie] ${created} hypothese(n) voorgesteld uit ${episodes.length} episode(s)`);
}

async function advanceWatermark(pool, runStartedAt) {
  try {
    await pool.query(
      `INSERT INTO reflection_progress (id, last_episode_captured_at, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE
       SET last_episode_captured_at = EXCLUDED.last_episode_captured_at, updated_at = now()`,
      [CHECKPOINT_ID, runStartedAt]
    );
  } catch (err) {
    console.error("[Reflectie] watermerk-bijwerking mislukt:", err.message);
  }
}

module.exports = {
  runHypothesisReflectionSync,
  reflectorFromEnv,
  buildJudgePrompt,
  parseJudgeOutput,
  CHECKPOINT_ID,
};
