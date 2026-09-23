const { pool } = require("./db");
const { embed } = require("./embedding");
const { getOrCreateInstelling } = require("./personaHelper");

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
    const { rows } = await pool.query(
      "SELECT * FROM persona_kenmerk WHERE embedding IS NOT NULL AND status != 'rejected' ORDER BY created_at ASC"
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
  startBackgroundJobs
};
