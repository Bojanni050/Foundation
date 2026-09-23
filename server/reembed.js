require("dotenv").config();
const { pool } = require("./db");
const { embed, getModel } = require("./embedding");

async function main() {
  console.log(`[Re-embed] Starting batch re-embedding using model: ${getModel()}`);
  try {
    // Select all kenmerken
    const { rows } = await pool.query("SELECT id, kenmerk FROM persona_kenmerk");
    console.log(`[Re-embed] Found ${rows.length} rows to re-embed.`);
    let successCount = 0;
    
    for (const row of rows) {
      try {
        const vector = await embed(row.kenmerk);
        const embeddingLiteral = `[${vector.join(",")}]`;
        await pool.query(
          "UPDATE persona_kenmerk SET embedding = $1 WHERE id = $2",
          [embeddingLiteral, row.id]
        );
        successCount++;
        console.log(`[Re-embed] Re-embedded ID: ${row.id} (${successCount}/${rows.length})`);
      } catch (err) {
        console.error(`[Re-embed] Failed to re-embed ID ${row.id}:`, err.message);
      }
    }
    console.log(`[Re-embed] Finished batch re-embedding. Successfully updated ${successCount}/${rows.length} rows.`);
  } catch (err) {
    console.error("[Re-embed] Batch re-embedding failed:", err.message);
  } finally {
    if (require.main === module) {
      await pool.end();
      console.log("[Re-embed] Database pool closed.");
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { reembedAllRows: main };
