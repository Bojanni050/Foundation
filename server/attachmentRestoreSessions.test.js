const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AttachmentRestoreSessionStore } = require("./attachmentRestoreSessions");

const deleted = [];
const store = new AttachmentRestoreSessionStore({
  deleteAttachmentById(id) {
    deleted.push(id);
    return true;
  },
});

const first = store.create();
store.record(first.id, "new_a", true);
store.record(first.id, "existing_b", false);
store.record(first.id, "new_a", true);
assert.deepEqual(store.rollback(first.id), { rolledBack: true, deleted: 1 });
assert.deepEqual(deleted, ["new_a"]);
assert.throws(() => store.require(first.id), /session not found/);

const second = store.create();
store.record(second.id, "new_c", true);
assert.deepEqual(store.finalize(second.id), { finalized: true, retainedNewAttachments: 1 });
assert.deepEqual(deleted, ["new_a"], "finalize must never delete restored attachments");

const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-restore-session-"));
try {
  const persistent = new AttachmentRestoreSessionStore({ sessionsDir, deleteAttachmentById: () => true });
  const persistedSession = persistent.create();
  persistent.record(persistedSession.id, "persisted_attachment", true);
  const afterRestart = new AttachmentRestoreSessionStore({ sessionsDir, deleteAttachmentById: () => true });
  assert.deepEqual(afterRestart.list(), [{
    id: persistedSession.id,
    createdAt: persistent.list()[0].createdAt,
    createdAttachmentIds: ["persisted_attachment"],
  }]);
  afterRestart.finalize(persistedSession.id);
  assert.deepEqual(afterRestart.list(), []);
} finally {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
}
console.log("ok - attachment restore sessions rollback only newly created files");
