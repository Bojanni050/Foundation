const assert = require("node:assert/strict");
const { findOrphanAttachmentIds } = require("./attachmentsStore");

const attachments = [{ id: "a" }, { id: "b" }, { id: "c" }];
assert.deepEqual(findOrphanAttachmentIds(attachments, ["a", "c"]), ["b"]);
assert.deepEqual(findOrphanAttachmentIds(attachments, []), ["a", "b", "c"]);
assert.deepEqual(findOrphanAttachmentIds([], ["a"]), []);
console.log("ok - attachment orphan classification is reference-based");
