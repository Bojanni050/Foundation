// Fire-and-forget bridge from the capture process to the memory-process's
// capture-activity ring buffer (captureActivityLog.js). The buffer lives in
// the memory-process; ingest and inbox/claim live in the capture process —
// two OS processes, so the event crosses the same loopback boundary the
// persona/embedding proxies already use. Visibility/debug only, by design:
// a failed notify (memory-process down or restarting) is swallowed and never
// slows or breaks the request it accompanies.

const MEMORY_HOST = "127.0.0.1";
const MEMORY_PORT = process.env.MEMORY_PORT || 4578;

function makeCaptureActivityNotifier({ fetchImpl = fetch, port = MEMORY_PORT } = {}) {
  return function notifyCaptureActivity({ title, sourceProvider, type } = {}) {
    return fetchImpl(`http://${MEMORY_HOST}:${port}/api/settings/capture-activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, sourceProvider, type }),
    }).catch(() => {
      // Memory-process not up yet or restarting — the ring buffer is
      // visibility only, so a missed entry is never worth failing on.
    });
  };
}

module.exports = {
  makeCaptureActivityNotifier,
  notifyCaptureActivity: makeCaptureActivityNotifier(),
};
