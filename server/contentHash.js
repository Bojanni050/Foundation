/**
 * Deterministic, fast content hash for deduplication.
 * Not cryptographic — just good enough to catch duplicate chat/text content.
 * Both frontend (IndexedDB) and server (inbox.json) use the same algorithm
 * so hashes are portable between them.
 *
 * @param {string} str — the text to hash
 * @returns {string} — stable hash like "ch_1a2b3c"
 */
function contentHash(str) {
  if (!str) return "";
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // force 32-bit integer
  }
  return "ch_" + Math.abs(hash).toString(36);
}

module.exports = { contentHash };
