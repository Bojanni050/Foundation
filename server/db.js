const { Pool } = require("pg");

// Schema and migrations are owned by ../db (Drizzle) — this server only queries
// the resulting tables with plain SQL, same file-based-simplicity spirit as the
// rest of this server (no ORM here).
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

module.exports = { pool };
