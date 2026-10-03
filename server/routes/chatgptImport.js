// Controls for the bulk importer (tools/chatgpt_bulk_import) — a
// Python/Playwright script that walks a logged-in ChatGPT/Gemini session and
// posts every conversation to the Ingestie Gateway (POST /api/ingest/chat).
// Foundation spawns/tracks it here
// (see chatgptImportManager.js) similarly to how it manages the memory-process.
const express = require("express");
const { requireAuth } = require("../auth");
const { startBulkImport, stopBulkImport, getStatus } = require("../chatgptImportManager");

const router = express.Router();

// GET /status blijft open als read-only health-uitzondering (zelfde beleid als
// de status-GET's in routes/settings.js); start/stop zijn mutating — start
// gooit een zware Playwright-importer aan die de hele pijp vulde zonder
// tokenplicht hier.
router.get("/status", (_req, res) => {
  res.json(getStatus());
});

// POST /api/settings/chatgpt-import/start  { limit?: number, headless?: boolean }
router.post("/start", requireAuth, async (req, res) => {
  const { limit, headless, provider, exportPath } = req.body || {};
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    return res.status(400).json({ error: "limit must be a positive integer" });
  }
  if (headless !== undefined && typeof headless !== "boolean") {
    return res.status(400).json({ error: "headless must be a boolean" });
  }
  if (provider !== undefined && provider !== "chatgpt" && provider !== "gemini" && provider !== "claude") {
    return res.status(400).json({ error: "provider must be 'chatgpt', 'gemini', or 'claude'" });
  }
  if (provider === "claude" && (!exportPath || typeof exportPath !== "string")) {
    return res.status(400).json({ error: "exportPath (path to the Anthropic export .zip or folder) is required for provider=claude" });
  }
  const result = await startBulkImport({ limit, headless, provider, exportPath });
  if (!result.started) {
    return res.status(result.reason === "already_running" ? 409 : 400).json(result);
  }
  res.json(result);
});

router.post("/stop", requireAuth, (_req, res) => {
  const result = stopBulkImport();
  if (!result.stopped) return res.status(409).json(result);
  res.json(result);
});

module.exports = router;
