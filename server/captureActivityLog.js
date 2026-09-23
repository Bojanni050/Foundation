// Lightweight, in-memory ring buffer of "what got captured" notifications.
// Fed by pollInbox() (frontend) right after it turns a claimed inbox item
// into a new or updated IndexedDB object — this is the "event-hook after
// distribution" plug-in point for the memory-process: pollInbox() stays the
// sole inbox claimant (no race), and this is visibility/debug only, by
// design — the memory-process takes no further action on these entries.
const MAX_ENTRIES = 200;
let entries = [];

function pushCaptureEvent({ title, sourceProvider, type }) {
  entries.push({
    title: title || "(untitled)",
    sourceProvider: sourceProvider || null,
    type: type || null,
    at: new Date().toISOString(),
  });
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

function getRecentCaptureEvents() {
  return entries;
}

module.exports = { pushCaptureEvent, getRecentCaptureEvents };
