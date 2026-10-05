/**
 * Derives a stable identifier for the conversation a source URL points to,
 * for cross-delivery idempotency: the same conversation delivered again —
 * grown, or through a second channel — should resolve to the same identity
 * instead of producing a duplicate object. contentHash alone can't do this:
 * it changes whenever the conversation's content changes (a genuine update,
 * not a duplicate) and can differ between two scrapers of the exact same
 * conversation (turndown vs markdownify formatting quirks).
 *
 * Both frontend (IndexedDB) and server (ingest_object) use the same algorithm
 * so ids are portable between them — same convention as contentHash.js.
 *
 * DECISION (2026-10-04, improvement #6): a null return is meaningful, not a
 * gap. Without a url there is no stable cross-delivery identity, so
 * routes/ingest.js writes provider_conversation_id NULL — the ON CONFLICT
 * target never matches and every delivery becomes its own `observation` row.
 * Deliberate: a resent blob of identical content is epistemically
 * indistinguishable from the same event genuinely occurring twice, and
 * Foundation's rule is to register what reaches the pipe. Sources that want
 * upsert semantics supply a url — capture-rs anchors
 * `capture://capture/<id>` for exactly this reason. Do not "fix" NULL rows
 * with a contentHash fallback without revisiting that ambiguity.
 *
 * @param {string|null|undefined} sourceProvider — e.g. "chatgpt", "claude", "gemini"
 * @param {string|null|undefined} url — the conversation URL
 * @returns {string|null} — e.g. "chatgpt:6198b802-...", or null if no url
 */
function deriveProviderConversationId(sourceProvider, url) {
  if (!url) return null;
  let clean = url;
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    clean = u.toString();
  } catch {
    // not a parseable absolute URL — fall through and use it as-is
  }

  if (sourceProvider === "chatgpt") {
    const m = clean.match(/\/c\/([a-f0-9-]{20,})/i);
    if (m) return `chatgpt:${m[1]}`;
  }
  if (sourceProvider === "claude") {
    const m = clean.match(/\/chat\/([a-f0-9-]{20,})/i);
    if (m) return `claude:${m[1]}`;
  }
  if (sourceProvider === "gemini") {
    const m = clean.match(/\/app\/([a-f0-9]{10,})/i);
    if (m) return `gemini:${m[1]}`;
  }

  // Unrecognized provider or URL shape — the normalized full URL is still a
  // meaningfully stable, comparable identity, just not as clean.
  return `${sourceProvider || "unknown"}:${clean}`;
}

module.exports = { deriveProviderConversationId };
