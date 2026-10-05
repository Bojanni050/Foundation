// Content-addressed blob store for whole source files (the original export a
// chat was parsed from). Foundation OWNS the original; Chronicle keeps an
// identical byte-for-byte copy. See Gaia-Documentation/capture-chronicle.md.
//
// Identity is the sha256 of the bytes: the same file uploaded twice is the
// same blob, so re-delivery is idempotent and a same-hash/different-bytes
// collision is impossible by construction (it would need a sha256 collision).
//
// Two backends share one interface (dual, per Bo's decision):
//   - local: content-addressed directories under server/data/blobs/
//   - s3:    prepared as a second implementation; selected via BLOB_STORE=s3
//
// The store never interprets content and never mutates a blob. Writes are
// add-only; identical bytes are reused, never rewritten.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HASH_RE = /^[a-f0-9]{64}$/;

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// A blob's metadata is derivable from its hash + size; the original filename
// and mime type are provenance, kept alongside but never used to locate bytes.
class LocalBlobStore {
  constructor(baseDir) {
    this.baseDir = baseDir || path.join(__dirname, "data", "blobs");
  }

  _dir(hash) {
    return path.join(this.baseDir, hash.slice(0, 2), hash);
  }

  /**
   * Stores bytes, returns their identity. Idempotent: an already-present blob
   * is reused unchanged (add-only), and its stored metadata is returned.
   */
  put(buffer, { filename, mimeType } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      const error = new Error("blob requires a non-empty buffer");
      error.code = "EMPTY_BLOB";
      throw error;
    }
    const hash = sha256(buffer);
    const dir = this._dir(hash);
    const metaPath = path.join(dir, "meta.json");

    if (fs.existsSync(metaPath)) {
      const existing = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      return { ...existing, reused: true };
    }

    fs.mkdirSync(dir, { recursive: true });
    const binPath = path.join(dir, "content");
    // wx: never overwrite an existing blob, even on a race.
    fs.writeFileSync(binPath, buffer, { flag: "wx" });
    const meta = {
      hash,
      size: buffer.length,
      filename: filename ? path.basename(filename) : null,
      mimeType: mimeType || "application/octet-stream",
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    return { ...meta, reused: false };
  }

  /** Reads a blob's bytes, or null when the hash is unknown. */
  get(hash) {
    const meta = this.getMeta(hash);
    if (!meta) return null;
    return fs.readFileSync(path.join(this._dir(hash), "content"));
  }

  /** Reads a blob's metadata (without the bytes), or null when unknown. */
  getMeta(hash) {
    if (typeof hash !== "string" || !HASH_RE.test(hash)) return null;
    const metaPath = path.join(this._dir(hash), "meta.json");
    if (!fs.existsSync(metaPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {
      return null;
    }
  }

  has(hash) {
    return this.getMeta(hash) !== null;
  }
}

// S3 backend placeholder with the same interface. Deliberately not implemented
// yet: the store is selected by config, so switching backends is a setting, not
// a rewrite. Kept here so the seam is explicit and callers never reach past it.
class S3BlobStore {
  constructor() {
    const error = new Error("S3BlobStore is not implemented yet — set BLOB_STORE=local");
    error.code = "S3_NOT_IMPLEMENTED";
    throw error;
  }
}

function createBlobStore(env = process.env) {
  if (env.BLOB_STORE === "s3") return new S3BlobStore(env);
  return new LocalBlobStore(env.BLOB_STORE_DIR);
}

module.exports = { createBlobStore, LocalBlobStore, S3BlobStore, sha256, HASH_RE };
