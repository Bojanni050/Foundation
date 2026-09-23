require("dotenv").config();

// Global safety net: a crash anywhere in an async/background path must never
// take down the whole Chronicle server — that's a much bigger blast radius
// than whatever actually failed. Anything genuinely fatal to Express itself
// still surfaces via its own request-handler error path, unaffected by this.
process.on("uncaughtException", (err) => {
  console.error("[Chronicle] Uncaught exception (server stays up):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[Chronicle] Unhandled promise rejection (server stays up):", reason);
});

const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const { Readable } = require("stream");
const { TOKEN, requireAuth } = require("./auth");
const { readInbox, writeInbox, pushToInbox } = require("./inboxStore");

const settingsRouter = require("./routes/settings");
const chatgptImportRouter = require("./routes/chatgptImport");
const attachmentsRouter = require("./routes/attachments");
const ingestRouter = require("./routes/ingest");
// Object embedding (POST /api/objects/:objectId/embed) is proxied to the
// memory-process below, not handled here — it used to be required and
// mounted directly in this process (`./routes/embedding`), which loaded a
// second, independent ~1.5-2GB copy of the ONNX embedding model into THIS
// process on top of the one memory-process already loads for its own
// Auto-Heal job. Same model, same file, two separate copies in memory for
// no benefit — proxying instead means exactly one process ever loads it.

// The consolidator/auto-heal jobs and the persona routes now live in their
// own OS process (server/memory-process/index.js) — spawned and proxied
// below. This is the capture/memory process split: a hang or crash on the
// memory side can no longer take the inbox/attachments endpoints
// down with it, since they're no longer sharing an event loop.
const MEMORY_HOST = "127.0.0.1";
const MEMORY_PORT = process.env.MEMORY_PORT || 4578;

const HOST = "127.0.0.1"; // localhost-only — never 0.0.0.0
const PORT = process.env.CHRONICLE_PORT || 4577;

const allowedOriginsPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$|^chrome-extension:\/\//;

// Retries only a connection-refused failure — the signature of "this
// sidecar process hasn't finished booting yet". The proxied process is
// spawned by this file and this file starts accepting requests immediately,
// well before the sidecar is actually listening: the memory-process
// loads a ~1.5-2GB ONNX embedding model first (see startMemoryProcess
// below). Same signature again, later, during the process's 3s
// auto-restart-on-crash window. Any other
// failure (a genuine hang, a bad upstream response) isn't retried — those
// aren't "not up yet", so retrying blindly would just add latency with no
// chance of succeeding. init.body is a plain JSON string here (not a
// stream), so it's safe to resend as-is on every attempt.
const CONN_REFUSED_RETRY_DELAYS_MS = [250, 500, 1000, 2000];

async function fetchWithConnRefusedRetry(target, init) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(target, init);
    } catch (err) {
      const isConnRefused = err.cause?.code === "ECONNREFUSED";
      if (!isConnRefused || attempt >= CONN_REFUSED_RETRY_DELAYS_MS.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, CONN_REFUSED_RETRY_DELAYS_MS[attempt]));
    }
  }
}

// Forwards a request byte-for-byte to the memory-process over loopback and
// streams the response back — including SSE (the /runs/:runId/events route
// depends on this staying a stream, not a buffered read). If the
// memory-process is still down after the retries above, this fails fast
// with a 503 instead of hanging the capture process's own event loop
// waiting on it.
async function proxyToMemory(req, res) {
  const target = `http://${MEMORY_HOST}:${MEMORY_PORT}${req.originalUrl}`;
  try {
    const headers = { ...req.headers };
    // Hop-by-hop / connection-specific headers that must never be forwarded
    // as-is: `host` would point fetch at the wrong origin, `content-length`
    // is recomputed below for the re-serialized body, and undici's fetch()
    // outright throws NotSupportedError on `expect` (PowerShell's
    // Invoke-RestMethod, curl, and other clients send `Expect: 100-continue`
    // on POSTs with a body — this broke every POST through this proxy,
    // not just this route). `connection`/`transfer-encoding` are similarly
    // connection-specific and never valid to replay on a new request.
    delete headers.host;
    delete headers["content-length"];
    delete headers.expect;
    delete headers.connection;
    delete headers["transfer-encoding"];

    const init = { method: req.method, headers };
    if (!["GET", "HEAD"].includes(req.method)) {
      init.body = JSON.stringify(req.body ?? {});
    }

    const upstream = await fetchWithConnRefusedRetry(target, init);
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-encoding") return; // fetch already decoded the body
      res.setHeader(key, value);
    });

    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error("[proxyToMemory] failed:", req.method, req.originalUrl, err.message, err.cause);
    res.status(503).json({ error: "Chronicle's memory-process is unreachable.", detail: err.message });
  }
}

const app = express();
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOriginsPattern.test(origin)) {
        return callback(null, true);
      } else {
        return callback(new Error("Not allowed by CORS"));
      }
    },
  })
);

// Enforce safe origins at routing level to block CSRF and unauthorized cross-origin requests
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !allowedOriginsPattern.test(origin)) {
    return res.status(403).json({ error: "Forbidden origin" });
  }
  next();
});

app.use(express.json({ limit: "10mb" }));

// Persona (and embedding) requests are forwarded to the memory-process over
// loopback. Mounted before settingsRouter so these more specific prefixes
// get first crack at matching; settingsRouter's own paths (token, status,
// embedding-model, seed) don't overlap with them and fall through untouched.
app.use("/api/settings/capture-activity", proxyToMemory);
app.use("/api/persona", proxyToMemory);
app.use("/api/memory", proxyToMemory);
app.post("/api/objects/:objectId/embed", proxyToMemory);

app.use("/api/settings", settingsRouter);
app.use("/api/settings/chatgpt-import", chatgptImportRouter);
app.use("/api/attachments", attachmentsRouter);

// Ingestie Gateway — server-side ingest met statusmarkering `observation` bij
// binnenkomst (typeward entry-points, zie routes/ingest.js). Onafhankelijk
// van de inbox/objects-import-route hierboven: dit is de officiële pijp voor
// alle externe capture-bronnen.
app.use("/api/ingest", ingestRouter);

// Extension (and other capture sources, e.g. uiaCapture.js) → queue an object
app.post("/api/objects/import", requireAuth, (req, res) => {
  const { type, source, title, content, sourceProvider, url, tags, turns, occurredAt, attachments } = req.body || {};
  if (!content) return res.status(400).json({ error: "content required" });
  const objectId = "inbox_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  pushToInbox({
    objectId,
    // Defaults match the actual browser extension, which never sends these
    // fields — other callers (uiaCapture.js sends type: "activity") were
    // previously silently overridden here and always filed as a chat.
    type: type || "chat",
    source: source || "extension",
    title: title || "Imported chat",
    content,
    sourceProvider: sourceProvider || null,
    url: url || null,
    tags: Array.isArray(tags) ? tags : [],
    // Structured role/text turns, kept alongside the flattened `content` so
    // the frontend can request message-level embeddings after import without
    // re-scraping. Optional — older extension versions won't send this.
    turns: Array.isArray(turns) ? turns : [],
    queuedAt: new Date().toISOString(),
    occurredAt: occurredAt || null,
    // Metadata only ({id, filename, mimeType, size, url} per item) — the
    // actual bytes were already POSTed to /api/attachments beforehand and
    // live on disk under server/data/attachments/. Optional, so older
    // callers (extension, manual imports) that never send this still work.
    attachments: Array.isArray(attachments) ? attachments : [],
  });
  res.status(201).json({ success: true, objectId });
});

// Web app → pull queued objects (localhost binding is the safety boundary)
app.get("/api/inbox", (_req, res) => {
  res.json(readInbox());
});

// POST /api/inbox/claim — atomic read-and-clear, in one request. Prevents
// the race that GET-then-later-DELETE has: if two separate frontend clients
// (e.g. a browser tab and the Tauri app, which have entirely separate
// IndexedDB storage) both poll the inbox, a plain GET can hand the same
// items to both before either gets around to clearing it. Since readInbox()/
// writeInbox() are synchronous, doing both within one handler — with no
// `await` in between — can't be interleaved by another request in Node's
// single-threaded event loop, so exactly one caller ever receives each item.
app.post("/api/inbox/claim", (_req, res) => {
  const items = readInbox();
  writeInbox([]);
  res.json(items);
});

// Web app → clear synced entries
app.delete("/api/inbox", (_req, res) => {
  writeInbox([]);
  res.json({ success: true });
});

// Spawn the memory-process (consolidator/auto-heal jobs, persona routes,
// the embedding pipeline) as its own OS process. stdio: "inherit" so its
// console output still shows up in the same terminal as Chronicle's own
// (concurrently already merges frontend+server output the same way).
// Restarted on unexpected exit — but critically, while it's down or
// restarting, Chronicle's own capture endpoints keep serving requests
// without interruption.
let memoryProcess = null;
let stoppingMemoryIntentionally = false;

function startMemoryProcess() {
  memoryProcess = spawn(
    process.execPath,
    [path.join(__dirname, "memory-process", "index.js")],
    { stdio: "inherit", env: process.env }
  );

  memoryProcess.on("exit", (code, signal) => {
    console.log(`[Chronicle] memory-process exited (code=${code}, signal=${signal})`);
    memoryProcess = null;
    if (!stoppingMemoryIntentionally) {
      console.log("[Chronicle] memory-process exited unexpectedly — restarting in 3s...");
      setTimeout(startMemoryProcess, 3000);
    }
  });

  memoryProcess.on("error", (err) => {
    console.error("[Chronicle] Failed to start memory-process:", err.message);
    memoryProcess = null;
  });
}

startMemoryProcess();

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  Chronicle local API running at http://${HOST}:${PORT}`);
  console.log(`  Token: ${TOKEN}`);
  console.log(`  (paste this token into the extension popup & the app Settings)\n`);
});

function shutdown() {
  console.log("\n  Shutting down Chronicle and subprocesses...");
  stoppingMemoryIntentionally = true;

  if (memoryProcess) {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", memoryProcess.pid, "/f", "/t"]);
    } else {
      memoryProcess.kill("SIGTERM");
    }
  }

  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
