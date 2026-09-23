const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { TOKEN } = require("./auth");

const SCRIPT_PATH = path.join(__dirname, "..", "tools", "chatgpt_bulk_import", "bulk_import.py");
const CHRONICLE_PORT = process.env.CHRONICLE_PORT || 4577;

let importProcess = null;
let startedAt = null;
let lastStoppedAt = 0;
let status = "idle"; // "idle" | "starting" | "running" | "stopping" | "exited"
let activeRunId = null;

// Windows' taskkill /f /t returns as soon as the process tree is signalled,
// not necessarily once Chrome has fully released the persistent profile
// directory's lock file — starting a new run immediately after Stop can
// race that. A short grace period after a stop is cheap insurance; genuine
// idle time between runs makes this a no-op.
const RESTART_GRACE_MS = 800;

// Ring-buffer of recent log lines — the frontend polls this instead of
// needing a persistent connection.
const MAX_LOG_LINES = 500;
let recentLogLines = [];

function pushLogLine(stream, text) {
  recentLogLines.push({ stream, text, at: new Date().toISOString() });
  if (recentLogLines.length > MAX_LOG_LINES) {
    recentLogLines.splice(0, recentLogLines.length - MAX_LOG_LINES);
  }
}

function getStatus() {
  return {
    running: status === "starting" || status === "running" || status === "stopping",
    status,
    startedAt,
    lines: recentLogLines,
  };
}

// spawn()'s ENOENT for a missing executable surfaces via the async 'error'
// event, which fires on a later tick than spawn() itself returns — by then
// startBulkImport would already have sent {started: true} back to the
// caller. Checking upfront lets a missing interpreter/script fail
// immediately and honestly instead of reporting fake success first.
function preflightCheck() {
  if (!fs.existsSync(SCRIPT_PATH)) {
    return `bulk_import.py not found at ${SCRIPT_PATH}`;
  }
  if (!TOKEN) {
    return "no Chronicle API token available";
  }
  try {
    execSync("python --version", { stdio: "ignore" });
  } catch {
    return "python not found on PATH — see tools/chatgpt_bulk_import/README.md";
  }
  return null;
}

async function startBulkImport({ limit, headless, provider = "chatgpt", exportPath } = {}) {
  if (status !== "idle" && status !== "exited") {
    return { started: false, reason: "already_running" };
  }

  if (provider === "claude" && !exportPath) {
    return { started: false, reason: "exportPath required for provider=claude" };
  }

  const preflightError = preflightCheck();
  if (preflightError) {
    return { started: false, reason: preflightError };
  }

  status = "starting";
  const runId = Date.now().toString();
  activeRunId = runId;

  try {
    const sinceStop = Date.now() - lastStoppedAt;
    if (sinceStop < RESTART_GRACE_MS) {
      await new Promise((resolve) => setTimeout(resolve, RESTART_GRACE_MS - sinceStop));
    }

    if (activeRunId !== runId || status === "stopping") {
        if (activeRunId === runId) {
            status = "exited";
            activeRunId = null;
        }
        return { started: false, reason: "stopped_before_spawn" };
    }

    recentLogLines = [];
    const args = [
      "-u", // unbuffered stdout
      SCRIPT_PATH,
      "--api-url", `http://127.0.0.1:${CHRONICLE_PORT}`,
      "--token", TOKEN,
      "--provider", provider,
    ];
    if (limit) args.push("--limit", String(limit));
    if (headless) args.push("--headless");
    if (provider === "claude" && exportPath) args.push("--export-path", exportPath);

    pushLogLine("stdout", `Starting bulk import (provider=${provider}, limit=${limit || "all"}, headless=${!!headless})...`);
    
    const child = spawn("python", args, {
      shell: process.platform === "win32",
    });
    importProcess = child;
    status = "running";
    startedAt = new Date().toISOString();

    let stdoutBuffer = "";
    child.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      lines.filter(Boolean).forEach((line) => pushLogLine("stdout", line));
    });

    let stderrBuffer = "";
    child.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";
      lines.filter(Boolean).forEach((line) => pushLogLine("stderr", line));
    });
    
    child.on("error", (err) => {
      pushLogLine("stderr", `Failed to start: ${err.message}`);
      if (activeRunId === runId) {
          status = "exited";
          importProcess = null;
          lastStoppedAt = Date.now();
      }
    });
    
    child.on("exit", (code, signal) => {
      if (stdoutBuffer) pushLogLine("stdout", stdoutBuffer);
      if (stderrBuffer) pushLogLine("stderr", stderrBuffer);
      pushLogLine("stdout", `Process exited (code=${code}, signal=${signal}).`);
      
      if (activeRunId === runId) {
          status = "exited";
          importProcess = null;
          lastStoppedAt = Date.now();
      }
    });

    return { started: true };
  } catch (err) {
      if (activeRunId === runId) {
          status = "exited";
          activeRunId = null;
      }
      return { started: false, reason: err.message };
  }
}

function stopBulkImport() {
  if (status !== "starting" && status !== "running") {
      return { stopped: false, reason: "not_running" };
  }
  
  const pid = importProcess ? importProcess.pid : null;
  status = "stopping";
  pushLogLine("stdout", "Stopping bulk import...");
  
  if (pid) {
      if (process.platform === "win32") {
        try { execSync(`taskkill /pid ${pid} /f /t`, { stdio: "ignore" }); } catch { /* already gone */ }
      } else {
        try { importProcess.kill("SIGTERM"); } catch { /* already gone */ }
      }
  } else {
      // If there was no PID, it was stopped before it spawned.
      // We still update the state properly.
      status = "exited";
      activeRunId = null;
      lastStoppedAt = Date.now();
  }
  
  // Notice we DO NOT set importProcess = null or status = "exited" here (if a PID existed).
  // The 'exit' handler of the child process will handle that when the process tree actually dies.
  return { stopped: true };
}

module.exports = { startBulkImport, stopBulkImport, getStatus };
