const fs = require("fs");
const path = require("path");
const { contentHash } = require("./contentHash");
const { deriveProviderConversationId } = require("./providerConversationId");

// Shared by server/index.js for every capture source that queues through
// /api/objects/import (extension imports, bulk import, WordPress connector,
// UIA activity capture) — a single read/write path avoids two writers
// racing on the same file.
const DATA_DIR = path.join(__dirname, "data");
const INBOX_FILE = path.join(DATA_DIR, "inbox.json");

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readInbox() {
  ensureData();
  try {
    return JSON.parse(fs.readFileSync(INBOX_FILE, "utf8") || "[]");
  } catch {
    return [];
  }
}

function writeInbox(arr) {
  ensureData();
  fs.writeFileSync(INBOX_FILE, JSON.stringify(arr, null, 2));
}

function pushToInbox(item) {
  const inbox = readInbox();
  // Skip if an item with the same content hash already sits in the inbox
  // (prevents the extension from queueing the same chat multiple times)
  const hash = item.content ? contentHash(item.content) : null;
  if (hash && inbox.some((existing) => existing.contentHash === hash)) {
    return item;
  }

  const providerConversationId = deriveProviderConversationId(item.sourceProvider, item.url);
  const entry = { ...item, contentHash: hash, providerConversationId };

  if (providerConversationId) {
    const existingIdx = inbox.findIndex((e) => e.providerConversationId === providerConversationId);
    if (existingIdx !== -1) {
      // Same conversation already queued but not yet claimed — e.g. the
      // bulk importer re-scraped it with more turns since it was first
      // queued. Replace with the newer version instead of queueing a
      // second copy that would become a duplicate object once claimed.
      inbox[existingIdx] = entry;
      writeInbox(inbox);
      return entry;
    }
  }

  inbox.push(entry);
  writeInbox(inbox);
  return entry;
}

module.exports = { readInbox, writeInbox, pushToInbox };
