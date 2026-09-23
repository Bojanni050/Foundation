const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { deleteAttachment } = require("./attachmentsStore");

class AttachmentRestoreSessionStore {
  constructor({ deleteAttachmentById = deleteAttachment, sessionsDir = null } = {}) {
    this.deleteAttachmentById = deleteAttachmentById;
    this.sessionsDir = sessionsDir;
    this.sessions = new Map();
  }

  manifestPath(sessionId) {
    return this.sessionsDir ? path.join(this.sessionsDir, `${sessionId}.json`) : null;
  }

  save(session) {
    if (!this.sessionsDir) return;
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    const manifest = {
      id: session.id,
      createdAt: session.createdAt,
      createdAttachmentIds: [...session.createdAttachmentIds],
    };
    const target = this.manifestPath(session.id);
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(manifest));
    fs.renameSync(temporary, target);
  }

  load(sessionId) {
    const target = this.manifestPath(sessionId);
    if (!target || !fs.existsSync(target)) return null;
    const manifest = JSON.parse(fs.readFileSync(target, "utf8"));
    if (manifest.id !== sessionId || !Array.isArray(manifest.createdAttachmentIds)) {
      throw new Error("invalid attachment restore session manifest");
    }
    const session = {
      id: sessionId,
      createdAt: manifest.createdAt,
      createdAttachmentIds: new Set(manifest.createdAttachmentIds),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  removeManifest(sessionId) {
    const target = this.manifestPath(sessionId);
    if (target && fs.existsSync(target)) fs.unlinkSync(target);
  }

  create() {
    const id = crypto.randomBytes(12).toString("hex");
    const session = { id, createdAttachmentIds: new Set(), createdAt: new Date().toISOString() };
    this.sessions.set(id, session);
    this.save(session);
    return { id };
  }

  require(sessionId) {
    if (!/^[a-f0-9]{24}$/.test(sessionId || "")) {
      const error = new Error("attachment restore session not found");
      error.code = "RESTORE_SESSION_NOT_FOUND";
      throw error;
    }
    const session = this.sessions.get(sessionId) || this.load(sessionId);
    if (!session) {
      const error = new Error("attachment restore session not found");
      error.code = "RESTORE_SESSION_NOT_FOUND";
      throw error;
    }
    return session;
  }

  record(sessionId, attachmentId, created) {
    const session = this.require(sessionId);
    if (created) session.createdAttachmentIds.add(attachmentId);
    this.save(session);
    return { trackedNewAttachments: session.createdAttachmentIds.size };
  }

  list() {
    if (this.sessionsDir && fs.existsSync(this.sessionsDir)) {
      for (const entry of fs.readdirSync(this.sessionsDir)) {
        const match = /^([a-f0-9]{24})\.json$/.exec(entry);
        if (match && !this.sessions.has(match[1])) this.load(match[1]);
      }
    }
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      createdAttachmentIds: [...session.createdAttachmentIds],
    }));
  }

  finalize(sessionId) {
    const session = this.require(sessionId);
    this.sessions.delete(sessionId);
    this.removeManifest(sessionId);
    return { finalized: true, retainedNewAttachments: session.createdAttachmentIds.size };
  }

  rollback(sessionId) {
    const session = this.require(sessionId);
    let deleted = 0;
    for (const attachmentId of session.createdAttachmentIds) {
      if (this.deleteAttachmentById(attachmentId)) deleted += 1;
    }
    this.sessions.delete(sessionId);
    this.removeManifest(sessionId);
    return { rolledBack: true, deleted };
  }
}

const attachmentRestoreSessions = new AttachmentRestoreSessionStore({
  sessionsDir: path.join(__dirname, "data", "restore-sessions"),
});

module.exports = { AttachmentRestoreSessionStore, attachmentRestoreSessions };
