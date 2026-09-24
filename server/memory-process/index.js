require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

// Own safety net, same reasoning as server/index.js: a crash anywhere in
// this process (consolidator, embedding pipeline) must never silently kill
// the process without at least being logged. This process is ALREADY
// isolated from Chronicle's capture process (separate OS process, separate
// event loop) — that isolation is the whole point of this file existing.
// These handlers are just the same defensive logging Chronicle itself has,
// not a replacement for that isolation.
process.on("uncaughtException", (err) => {
  console.error("[Memory] Uncaught exception (process stays up):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[Memory] Unhandled promise rejection (process stays up):", reason);
});

const express = require("express");
const { startBackgroundJobs } = require("../jobs");

const personaRouter = require("../insight/routes/persona");
// Object embedding lives here (not in Chronicle's capture process) so the
// ONNX embedding pipeline is only ever loaded into memory once, in this
// process — it was previously also required directly by server/index.js,
// which meant every embed() call loaded a second, fully independent copy of
// the same ~1.5-2GB model in the capture process too. Chronicle's own
// process now proxies /api/objects/:objectId/embed here instead (see
// proxyToMemory in server/index.js), the same pattern already used for
// persona requests.
const embeddingRouter = require("../routes/embedding");
const memoryRouter = require("../routes/memory");
const { pushCaptureEvent, getRecentCaptureEvents } = require("../captureActivityLog");
const { getResourceUsage } = require("../resourceUsage");

// Localhost-only, never exposed to the browser directly — Chronicle's
// capture process (server/index.js) is the only caller, proxying
// /api/persona requests here over loopback. No CORS/origin middleware
// needed for that reason: this port never receives a browser-origin request.
const HOST = "127.0.0.1";
const PORT = process.env.MEMORY_PORT || 4578;

const app = express();

app.use(express.json({ limit: "10mb" }));

app.use("/api/persona", personaRouter);
app.use("/api/objects", embeddingRouter); // POST /api/objects/:objectId/embed
app.use("/api/memory", memoryRouter); // episodes, hypotheses, evidence, knowledge gaps

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// GET /api/memory/resource-usage — this process's own CPU/memory (the
// memory engine: consolidator, auto-heal, embedding pipeline, persona/
// hypothesis routes). Reachable through Chronicle's existing /api/memory
// proxy (server/index.js's proxyToMemory) — no separate proxy route needed.
// Mounted directly here rather than in routes/memory.js since it reports on
// the process itself, not on episodes/hypotheses/evidence data.
app.get("/api/memory/resource-usage", (_req, res) => {
  res.json(getResourceUsage());
});

// POST/GET /api/settings/capture-activity — the "event-hook after
// distribution" plug-in point: pollInbox() (frontend) stays the sole inbox
// claimant (no race with anything here), and calls this right after it
// creates or updates an object from a claimed item. Visibility/debug only,
// by design — nothing here triggers further memory-side action on its own.
app.post("/api/settings/capture-activity", (req, res) => {
  const { title, sourceProvider, type } = req.body || {};
  pushCaptureEvent({ title, sourceProvider, type });
  res.status(201).json({ success: true });
});
app.get("/api/settings/capture-activity", (_req, res) => {
  res.json({ entries: getRecentCaptureEvents() });
});

// GET/PATCH /api/settings/integrations + POST .../run — UI-beheer van de
// Hindsight-pijp en reflectie-engine. Hier gemount, niet in het
// capture-proces: de jobs en de effective-config leven in dit proces, dus
// een handmatige run-route hoeft niets te crossen. Bereikbaar via de
// bestaande /api/settings/integrations-proxy in server/index.js.
app.use("/api/settings/integrations", require("./integrationRoutes"));

// Start background schedulers (consolidator, auto-heal). If either hangs or
// crashes, only this process is affected — Chronicle's capture endpoints
// (inbox, attachments, connectors) keep responding regardless, since they
// live in a different OS process.
startBackgroundJobs();

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  Chronicle memory-process running at http://${HOST}:${PORT}\n`);
});

function shutdown() {
  console.log("[Memory] Shutting down...");
  server.close(() => process.exit(0));
  // Force-exit if close() hangs (e.g. an open connection keeping the server
  // alive) — this process must not become an orphan itself.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
