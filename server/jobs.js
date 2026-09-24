const { pool } = require("./db");
const { embed } = require("./embedding");
const { getOrCreateInstelling } = require("./personaHelper");
const { runIngestBridge } = require("./ingestBridge");
const { runHindsightSync } = require("./hindsightSync");
const { runHypothesisReflectionSync, reflectorFromEnv } = require("./hypothesisReflectionSync");
const { createHindsightClient } = require("./hindsightClient");
const { getIntegrationConfig } = require("./integrationConfig");

async function runAutoHealEmbeddings() {
  console.log("[Auto-Heal] Running background auto-heal loop for missing embeddings...");
  try {
    const { rows } = await pool.query(
      "SELECT id, kenmerk FROM persona_kenmerk WHERE embedding IS NULL LIMIT 10"
    );
    for (const row of rows) {
      console.log(`[Auto-Heal] Auto-healing missing embedding for ID: ${row.id}...`);
      try {
        const vector = await embed(row.kenmerk);
        const embeddingLiteral = `[${vector.join(",")}]`;
        await pool.query(
          "UPDATE persona_kenmerk SET embedding = $1 WHERE id = $2",
          [embeddingLiteral, row.id]
        );
        console.log(`[Auto-Heal] Successfully auto-healed ID: ${row.id}`);
      } catch (err) {
        console.error(`[Auto-Heal] Failed to auto-heal ID ${row.id}:`, err.message);
        break; // Stop loop if embedding fails (model not loaded, offline, etc.)
      }
    }
  } catch (err) {
    console.error("[Auto-Heal] Auto-heal query failed:", err.message);
  }
}

async function consolidateKenmerken() {
  console.log("[Consolidator] Running persona consolidation job...");
  try {
    // Query all non-rejected kenmerken that have embeddings
    // Stash-geïnspireerd watermerk (consolidation_progress, migratie 0021):
    // alleen sinds de vorige voltooide run aangemaakte kenmerken worden
    // outer-gescand; elk wordt nog wel tegen ALLE niet-rejected kenmerken
    // vergeleken (de per-item similarity-query filtert niet op created_at),
    // dus merge-coverage blijft identiek — de scan zelf is incrementeel.
    const { rows: nowRows } = await pool.query("SELECT now() AS run_started_at");
    const runStartedAt = nowRows[0].run_started_at;
    const { rows: cpRows } = await pool.query(
      "SELECT last_run FROM consolidation_progress WHERE id = '00000000-0000-0000-0000-000000000000'"
    );
    const lastRun = cpRows[0] ? cpRows[0].last_run : null;
    const { rows } = await pool.query(
      `SELECT * FROM persona_kenmerk
       WHERE embedding IS NOT NULL AND status != 'rejected'
         AND created_at > COALESCE($1, to_timestamp(0))
         AND created_at <= $2
       ORDER BY created_at ASC`,
      [lastRun, runStartedAt]
    );
    
    const processedIds = new Set();
    
    for (const current of rows) {
      if (processedIds.has(current.id)) continue;
      
      // Find similar traits (cosine similarity > 0.75) — scoped to the same
      // categorie so an "algemeen" fact never merges into a "persona" trait
      // (or vice versa) just because their embeddings happen to be close.
      const { rows: matches } = await pool.query(
        `SELECT id, kenmerk, status, zekerheid, bron_object_ids, soort, categorie, 1 - (embedding <=> $1) AS similarity
         FROM persona_kenmerk
         WHERE id != $2 AND embedding IS NOT NULL AND status != 'rejected' AND categorie = $3 AND (1 - (embedding <=> $1)) > 0.75`,
        [current.embedding, current.id, current.categorie]
      );

      if (matches.length > 0) {
        console.log(`[Consolidator] Consolidating duplicates for: "${current.kenmerk}"`);
        let mergedBronObjectIds = [...current.bron_object_ids];
        let highestStatus = current.status;
        let highestZekerheid = current.zekerheid;
        let isFeit = current.soort === "feit" || current.categorie === "algemeen";
        
        const statusWeight = { observation: 1, hypothesis: 2, confirmed: 3, rejected: 0 };
        
        for (const match of matches) {
          processedIds.add(match.id);

          for (const id of match.bron_object_ids) {
            if (!mergedBronObjectIds.includes(id)) {
              mergedBronObjectIds.push(id);
            }
          }
          
          if (statusWeight[match.status] > statusWeight[highestStatus]) {
            highestStatus = match.status;
          }
          
          if (match.zekerheid > highestZekerheid) {
            highestZekerheid = match.zekerheid;
          }
          
          if (match.soort === "feit") {
            isFeit = true;
          }
          
          // Mark merged trait as rejected — points at the survivor
          // (vervangen_door) so the consolidation trail stays inspectable,
          // per the manifest's requirement that a consolidation-rejected
          // record permanently references what it was merged into. verwerp_bron
          // = 'consolidatie' distinguishes this from a mens-rejectie: this
          // record must never resurrect on its own (it lives on in the survivor).
          await pool.query(
            "UPDATE persona_kenmerk SET status = 'rejected', vervangen_door = $1, verwerp_bron = 'consolidatie' WHERE id = $2",
            [current.id, match.id]
          );
        }
        
        if (isFeit) {
          highestZekerheid = 100;
        } else {
          // Recompute certainty/status based on new merged sources list
          const instelling = await getOrCreateInstelling();
          const newZekerheid = Math.min(100, Math.round((100 * mergedBronObjectIds.length) / instelling.promotie_min_bronnen));
          highestZekerheid = Math.max(highestZekerheid, newZekerheid);
          
          if (highestStatus === "observation" && mergedBronObjectIds.length >= instelling.promotie_min_bronnen) {
            highestStatus = "hypothesis";
          }
        }
        
        // Update the consolidated trait
        await pool.query(
          `UPDATE persona_kenmerk 
           SET bron_object_ids = $1, zekerheid = $2, status = $3, laatst_versterkt_op = now()
           WHERE id = $4`,
          [mergedBronObjectIds, highestZekerheid, highestStatus, current.id]
        );
      }
    }

    // Watermerk pas ná volledige verwerking van de batch opschrijven — een
    // crash halverwege herverwerkt dezelfde rijen gewoon bij de volgende run
    // (de merge-logica is aan de survivor-kant idempotent).
    await pool.query(
      `INSERT INTO consolidation_progress (id, last_run)
       VALUES ('00000000-0000-0000-0000-000000000000', $1)
       ON CONFLICT (id) DO UPDATE SET last_run = EXCLUDED.last_run, updated_at = now()`,
      [runStartedAt]
    );
  } catch (err) {
    console.error("[Consolidator] Consolidator failed:", err.message);
  }
}

// Start background schedulers
function startBackgroundJobs() {
  setInterval(runAutoHealEmbeddings, 300000); // 5 minutes
  setInterval(consolidateKenmerken, 300000);  // 5 minutes

  setTimeout(runAutoHealEmbeddings, 10000);  // 10 seconds after startup
  setTimeout(consolidateKenmerken, 12000);   // 12 seconds after startup

  // Ingest-bridge: vries nieuwe ingest_object-rijen als episode. Draait hier
  // (memory-proces), niet in het capture-proces — zie server/ingestBridge.js.
  setInterval(runIngestBridge, 60000);      // 1 minute
  setTimeout(runIngestBridge, 15000);       // 15 seconds after startup

  // Reflectie-pijp naar Hindsight (zelfde VPS): mens-bevestigde feiten
  // doorzetten naar de bank. Configuratie komt per run uit integration_config
  // (UI-beheer, server/integrationConfig.js) met env-fallback — de pijp leest
  // hem elke tick opnieuw, dus een UI-wijziging geldt zonder herstart. Zonder
  // configuratie is er geen pijp, geen fout elke minuut. Zie
  // server/hindsightSync.js.
  const runPijp = async () => {
    const config = await getIntegrationConfig();
    if (!config.hindsightUrl || !config.hindsightBankId) return;
    let client;
    try {
      client = createHindsightClient({
        baseUrl: config.hindsightUrl,
        bankId: config.hindsightBankId,
      });
    } catch (err) {
      console.error("[HindsightSync] configuratie ongeldig, pijp slaat run over:", err.message);
      return;
    }
    return runHindsightSync({ client });
  };
  setInterval(runPijp, 300000);   // 5 minutes
  setTimeout(runPijp, 20000);      // 20 seconds after startup

  // Reflectie-engine: nieuwe episodes tegen actieve feiten laten beoordelen
  // door de reflectie-LLM; stelt OPEN hypotheses voor (supersessie als
  // update), de mens bevestigt/verwerpt via de bestaande routes. Configuratie
  // per run uit integration_config met env-fallback — zelfde reden als bij
  // de pijp hierboven. Zie server/hypothesisReflectionSync.js.
  const runEngine = async () => {
    const config = await getIntegrationConfig();
    if (!config.reflectionLlmApiKey || !config.reflectionLlmBaseUrl || !config.reflectionLlmModel) return;
    const reflector = reflectorFromEnv({
      apiKey: config.reflectionLlmApiKey,
      baseUrl: config.reflectionLlmBaseUrl,
      model: config.reflectionLlmModel,
    });
    if (!reflector) return;
    return runHypothesisReflectionSync({ reflector });
  };
  setInterval(runEngine, 900000);  // 15 minutes
  setTimeout(runEngine, 30000);     // 30 seconds after startup

  // Screenpipe is gated behind its own subscription now and unusable.
  // PureMemory's external Go collector-agent has been replaced by native
  // Windows UI Automation capture embedded directly in the Tauri app (see
  // src-tauri/src/uia_capture.rs) — unlike PureMemory, that one is started
  // by the frontend (via a Tauri command) rather than spawned here, so
  // there's nothing left for the Node server to start on its behalf.
}

module.exports = {
  runAutoHealEmbeddings,
  consolidateKenmerken,
  runIngestBridge,
  startBackgroundJobs
};
