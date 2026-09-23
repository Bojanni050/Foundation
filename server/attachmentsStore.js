const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data", "attachments");

// Content-addressed by a random id, not by filename — two uploads named
// "image.png" never collide, and the id alone (not the original name) is
// what actually locates the file on disk.
const ID_RE = /^[a-f0-9]{24}$/;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function saveAttachment(buffer, filename, mimeType) {
  ensureDir();
  const id = crypto.randomBytes(12).toString("hex");
  const dir = path.join(DATA_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const safeName = path.basename(filename || "file").replace(/[^\w.\-]+/g, "_") || "file";
  fs.writeFileSync(path.join(dir, safeName), buffer);
  const meta = {
    id,
    filename: safeName,
    mimeType: mimeType || "application/octet-stream",
    size: buffer.length,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
  return meta;
}

// Restore keeps the archived id so repeated imports are idempotent and object
// metadata never needs to be rewritten. A same-id/different-bytes collision is
// rejected loudly instead of silently replacing a local file.
function restoreAttachment(buffer, id, filename, mimeType) {
  if (!ID_RE.test(id)) {
    const error = new Error("invalid attachment id");
    error.code = "INVALID_ATTACHMENT_ID";
    throw error;
  }
  const existing = getAttachment(id);
  if (existing) {
    const existingBytes = fs.readFileSync(existing.filePath);
    if (!existingBytes.equals(buffer)) {
      const error = new Error(`attachment id conflict: ${id}`);
      error.code = "ATTACHMENT_ID_CONFLICT";
      throw error;
    }
    return { ...existing, reused: true };
  }

  ensureDir();
  const dir = path.join(DATA_DIR, id);
  fs.mkdirSync(dir);
  const safeName = path.basename(filename || "file").replace(/[^\w.\-]+/g, "_") || "file";
  fs.writeFileSync(path.join(dir, safeName), buffer);
  const meta = {
    id,
    filename: safeName,
    mimeType: mimeType || "application/octet-stream",
    size: buffer.length,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
  return { ...meta, reused: false };
}

// Always resolves the served file from meta.json's own recorded filename,
// never from a caller-supplied path segment — the :filename in the GET
// route is cosmetic (matches what saveAttachment returned, for a sane
// download name) and never used to build a filesystem path.
function getAttachment(id) {
  if (!ID_RE.test(id)) return null;
  const dir = path.join(DATA_DIR, id);
  const metaPath = path.join(dir, "meta.json");
  if (!fs.existsSync(metaPath)) return null;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
  const filePath = path.join(dir, meta.filename);
  if (!fs.existsSync(filePath)) return null;
  return { ...meta, filePath };
}

function listAttachments() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ID_RE.test(entry.name))
    .map((entry) => getAttachment(entry.name))
    .filter(Boolean)
    .map(({ filePath: _filePath, ...meta }) => meta);
}

function findOrphanAttachmentIds(attachments, referencedIds) {
  const referenced = new Set((referencedIds || []).filter((id) => typeof id === "string"));
  return attachments.map((attachment) => attachment.id).filter((id) => !referenced.has(id));
}

function purgeOrphanAttachments(referencedIds) {
  const attachments = listAttachments();
  const orphanIds = findOrphanAttachmentIds(attachments, referencedIds);
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  let bytes = 0;
  for (const id of orphanIds) {
    const dir = path.resolve(DATA_DIR, id);
    if (path.dirname(dir) !== path.resolve(DATA_DIR) || !ID_RE.test(id)) {
      throw new Error(`refusing unsafe attachment path: ${id}`);
    }
    bytes += Number(byId.get(id)?.size || 0);
    fs.rmSync(dir, { recursive: true, force: false });
  }
  return { deleted: orphanIds.length, bytes, ids: orphanIds };
}

function deleteAttachment(id) {
  if (!ID_RE.test(id)) throw new Error(`invalid attachment id: ${id}`);
  const dir = path.resolve(DATA_DIR, id);
  if (path.dirname(dir) !== path.resolve(DATA_DIR)) throw new Error(`refusing unsafe attachment path: ${id}`);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: false });
  return true;
}

module.exports = {
  saveAttachment,
  restoreAttachment,
  getAttachment,
  listAttachments,
  findOrphanAttachmentIds,
  purgeOrphanAttachments,
  deleteAttachment,
};
