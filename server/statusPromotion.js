const ALLOWED_TABLES = new Set(["persona_kenmerk"]);

/**
 * Chronicle Manifest V6, §5: "Een `rejected`-record mag nooit, via welke
 * rekenkundige weg dan ook, stilzwijgend promoveren." This is the one place
 * that guarantee is enforced — every status-writing code path (the
 * consolidator, versterk/reinforce, samenvoegen, reflectie, and confirm/
 * reject routes on persona_kenmerk) must call this BEFORE writing a new
 * status, instead of each route/job re-implementing its own check. A single
 * shared guard is the point of this function: fix the rule once here, not
 * once per caller.
 *
 * allowResurrection must be explicitly passed by a dedicated resurrection
 * code path. None exists yet (see Manifest §5, "Heropstanding") — every
 * current caller omits it, so a rejected record cannot change status at all
 * right now except by going through that not-yet-built path later.
 *
 * Throws (never silently no-ops) so a caller can't accidentally swallow a
 * violation — this must be loud, not quiet, when it fires.
 */
async function assertStatusChangeAllowed(pool, table, id, newStatus, { allowResurrection = false } = {}) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`assertStatusChangeAllowed: unknown table "${table}"`);
  }
  const { rows } = await pool.query(`SELECT status FROM ${table} WHERE id = $1`, [id]);
  if (!rows[0]) {
    throw new Error(`assertStatusChangeAllowed: ${table} record not found: ${id}`);
  }
  if (rows[0].status === "rejected" && newStatus !== "rejected" && !allowResurrection) {
    throw new Error(
      `assertStatusChangeAllowed: refusing to promote a rejected ${table} record (id=${id}) ` +
        `to "${newStatus}" without an explicit resurrection path`
    );
  }
  return { previousStatus: rows[0].status };
}

module.exports = { assertStatusChangeAllowed };
