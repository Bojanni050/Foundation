/**
 * Derives a stable identifier for the conversation a source URL points to,
 * for cross-import idempotency: the same ChatGPT conversation imported once
 * via the browser extension and once via the bulk importer — or the bulk
 * importer re-run after the conversation grew — should resolve to the same
 * identity instead of producing a duplicate object. contentHash alone can't
 * do this: it changes whenever the conversation's content changes (a
 * genuine update, not a duplicate) and can differ between two scrapers of
 * the exact same conversation (turndown vs markdownify formatting quirks).
 *
 * Both frontend (IndexedDB) and server (inbox.json) use the same algorithm
 * so ids are portable between them — same convention as contentHash.js.
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
