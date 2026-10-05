// Root-.env eerst (één configuratieplek voor de hele stack), daarna een
// eventuele server/.env als override.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
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

const settingsRouter = require("./routes/settings");
const attachmentsRouter = require("./routes/attachments");
const sourceFilesRouter = require("./routes/sourceFiles");
const ingestRouter = require("./routes/ingest");
// Object embedding (POST /api/objects/:objectId/embed) is proxied to the
// memory-process below, not handled here — it used to be required and
// mounted directly in this process (`./routes/embedding`), which loaded a
// second, independent ~1.5-2GB copy of the ONNX embedding model into THIS
// process on top of the one memory-process already loads for its own
// Auto-Heal job. Same model, same file, two separate copies in memory for
// no benefit — proxying instead means exactly one process ever loads it.

// The auto-heal/ingest-bridge jobs and the persona routes now live in their
// own OS process (server/memory-process/index.js) — spawned and proxied
// below. This is the capture/memory process split: a hang or crash on the
// memory side can no longer take the ingest/attachments endpoints
// down with it, since they're no longer sharing an event loop.
const MEMORY_HOST = "127.0.0.1";
const MEMORY_PORT = process.env.MEMORY_PORT || 4578;

// Loopback by default. CHRONICLE_HOST kan de binding verplaatsen naar één
// specifieke privé-interface (bijv. het Tailscale-IP, zodat de UI/API binnen
// het tailnet bereikbaar is) — maar nooit 0.0.0.0: alleen benoemde
// interfaces, anders hangt alles aan het open internet.
const HOST = process.env.CHRONICLE_HOST || "127.0.0.1";
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

// Ruwe-byte-uploads (bronbestanden én attachments) dragen geen JSON — de
// globale JSON-parser moet ze overslaan, anders faalt de body met "Bad
// Request" nog vóór de route (die zelf express.raw gebruikt).
const RAW_UPLOAD_PREFIXES = ["/api/source-files", "/api/attachments"];
app.use(
  express.json({
    limit: "10mb",
    type: (req) => !RAW_UPLOAD_PREFIXES.some((prefix) => req.path.startsWith(prefix)),
  })
);

// Persona (and embedding) requests are forwarded to the memory-process over
// loopback. Mounted before settingsRouter so these more specific prefixes
// get first crack at matching; settingsRouter's own paths (token, status,
// embedding-model, seed) don't overlap with them and fall through untouched.
// requireAuth sits HERE, at the capture-process boundary: the memory-process
// itself stays unauthenticated (it binds loopback and is never directly
// reachable), so this proxy is the one place the public edge is guarded.
app.use("/api/settings/capture-activity", requireAuth, proxyToMemory);
// UI-beheer van integratie-config (lees/schrijf) — lives in het
// memory-proces. De achtergrondjobs erachter (Hindsight-pijp,
// reflectie-engine, consolidator-promotie) zijn uitgeschakeld: Foundation
// vuurt niet tegen de gedeelde Hindsight-bank (zie server/jobs.js); de
// handmatige .../run-routes antwoorden 410 Gone.
// Auth hier, op de publieke rand: deze routes schrijven integratie-config
// (o.a. LLM-endpoints) — nooit een losse deur.
app.use("/api/settings/integrations", requireAuth, proxyToMemory);
// Ingestie/capture-logdashboard: data-endpoint (routes/ingestLogs.js) en
// de statische pagina (public/index.html, op /ui). De pagina vraagt bij
// eerste gebruik om de bearer-token en bewaart die in localStorage —
// dezelfde authenticatie als elke andere caller, geen losse deur.
app.use("/api/ingest-logs", require("./routes/ingestLogs"));
app.use("/ui", express.static(path.join(__dirname, "public")));

app.use("/api/persona", requireAuth, proxyToMemory);
app.use("/api/memory", requireAuth, proxyToMemory);
app.post("/api/objects/:objectId/embed", requireAuth, proxyToMemory);

app.use("/api/settings", settingsRouter);
app.use("/api/attachments", attachmentsRouter);
app.use("/api/source-files", sourceFilesRouter);

// Ingestie Gateway — server-side ingest met statusmarkering `observation` bij
// binnenkomst (typeward entry-points, zie routes/ingest.js). Dit is de enige
// officiële pijp voor alle externe bronnen: de legacy inbox-route
// (/api/objects/import + /api/inbox-drieluik, "bruggetje" in de oude README)
// is verwijderd — de gateway-upsert (provider_conversation_id) dekt exact
// wat de inbox deed, epistemisch correcter en met de veldcontracten van
// ingestPolicy. Er is geen achtergebleven client: de enige browser-extensie
// in de stack (capture-rs) praat alleen met diens eigen lokale bridge, nooit
// met Foundation; de oude Chronicle-extensie die hier postte is verleden.
app.use("/api/ingest", ingestRouter);

// Spawn the memory-process (auto-heal/ingest-bridge jobs, persona routes,
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
  console.log(`  (token for capture clients & the UI; mcpServer.js reads data/token.txt itself)`);
  if (!["127.0.0.1", "localhost", "::1"].includes(HOST)) {
    console.log(`  ⚠ Binding outside loopback: every API route now enforces the bearer token`);
    console.log(`    (memory/persona/ingest), and GET /api/settings/token is`);
    console.log(`    loopback-only — hand out server/data/token.txt out-of-band.\n`);
  } else {
    console.log("");
  }
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
