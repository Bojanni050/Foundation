#!/usr/bin/env node
// Chronicle's epistemic-memory MCP server — exposes search and the
// propose-only half of the hypothesis/evidence/episode API to an external
// MCP client (e.g. Claude Desktop) over stdio.
//
// Deliberately NO confirm/reject/knowledge-gap-transition tools. Every rule
// this whole memory system is built around comes down to one thing: nothing
// is promoted except by an explicit human action, taken in the Chronicle app
// itself. Exposing a callable "confirm_hypothesis" tool here would let
// whichever model is on the other end of this MCP connection make that call
// unilaterally — exactly the "automatic confirmation" failure mode this
// system exists to avoid. If you want to confirm or reject something, open
// Chronicle and do it there.
//
// A thin HTTP client over the existing /api/memory REST API on purpose —
// no business logic is duplicated here (dedup, embeddings, validation all
// still live in exactly one place: server/routes/memory.js).
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const z = require("zod");

const API_URL = process.env.CHRONICLE_API_URL || "http://127.0.0.1:4577";

async function apiRequest(basePath, path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_URL}${basePath}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
  } catch (err) {
    throw new Error(`Chronicle server unreachable at ${API_URL} — is it running? (${err.message})`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.details ? `: ${body.details.join("; ")}` : body.error ? `: ${body.error}` : "";
    throw new Error(`Request failed (${response.status})${detail}`);
  }
  return body;
}

function memoryRequest(path, options = {}) {
  return apiRequest("/api/memory", path, options);
}

function ingestRequest(path, options = {}) {
  return apiRequest("/api/ingest", path, options);
}

function ingestLogsRequest(path, options = {}) {
  return apiRequest("/api/ingest-logs", path, options);
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err) {
  return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
}

const server = new McpServer({ name: "chronicle-memory", version: "1.0.0" });

server.registerTool(
  "search_memory",
  {
    title: "Search Chronicle's memory",
    description:
      "Semantic search across Chronicle's hypotheses and confirmed facts together. Each result carries its own " +
      "semanticRelevance/temporalFit/sourceQuality/confidence scores — an open, unverified hypothesis and a " +
      "confirmed fact are both returned, clearly labeled (kind: \"hypothesis\"|\"fact\", status/superseded), so " +
      "you can judge how settled a claim actually is rather than treating every result as equally reliable.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
    },
  },
  async ({ query, limit }) => {
    try {
      return textResult(await memoryRequest(`/search?${new URLSearchParams({ q: query, ...(limit ? { limit: String(limit) } : {}) })}`));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "list_hypotheses",
  {
    title: "List hypotheses",
    description: 'List Chronicle\'s hypotheses, optionally filtered by status ("open", "confirmed", or "rejected").',
    inputSchema: {
      status: z.enum(["open", "confirmed", "rejected"]).optional(),
    },
  },
  async ({ status }) => {
    try {
      return textResult(await memoryRequest(`/hypotheses${status ? `?status=${status}` : ""}`));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "get_hypothesis",
  {
    title: "Get a hypothesis",
    description:
      "Full detail for one hypothesis: its evidence (each with the frozen episode it came from), the current " +
      "verification verdict (read-only — meeting the bar never changes anything by itself), and its resulting " +
      "fact if it has been confirmed.",
    inputSchema: { id: z.string().describe("Hypothesis id") },
  },
  async ({ id }) => {
    try {
      return textResult(await memoryRequest(`/hypotheses/${encodeURIComponent(id)}`));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "list_facts",
  {
    title: "List facts",
    description:
      "List Chronicle's facts — the confirmed output of hypotheses. activeOnly restricts to facts nothing has " +
      "superseded yet (the current understanding); omit it to include historical, superseded facts too.",
    inputSchema: { activeOnly: z.boolean().optional() },
  },
  async ({ activeOnly }) => {
    try {
      return textResult(await memoryRequest(`/facts${activeOnly ? "?active=true" : ""}`));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "create_episode",
  {
    title: "Freeze an observation as an episode",
    description:
      "Freezes one raw observation as an immutable, append-only episode — the frozen source material a piece of " +
      "evidence later interprets. bronObjectId must reference an object that already exists in Chronicle's own " +
      "archive (an imported chat, a note, ...); this tool captures observations about already-archived content, " +
      "it does not archive this live conversation itself. Exact retries (same content) are idempotent.",
    inputSchema: {
      bronObjectId: z.string().describe("Id of the existing Chronicle object this observation comes from"),
      bronsoort: z.string().describe('Kind of source, e.g. "chat", "note", "document"'),
      fragment: z.string().describe("The actual quoted or closely paraphrased text"),
      sourceType: z.enum(["chat-import", "document", "explicit-input", "system-observation"]),
      spreker: z.string().optional().describe("Who said it, if identifiable"),
      observedAt: z.string().optional().describe("ISO timestamp of when the source content itself occurred"),
      bronReferentie: z.string().optional().describe("Precise pointer within the source, e.g. a turn index"),
      conversationIdentity: z.string().optional().describe('Provider-conversation identity, e.g. "chatgpt:<uuid>"'),
      extractionConfidence: z.number().int().min(0).max(100).optional(),
      contextWindow: z.string().optional().describe("Short surrounding text for interpretation"),
    },
  },
  async (input) => {
    try {
      return textResult(await memoryRequest("/episodes", { method: "POST", body: JSON.stringify(input) }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "propose_hypothesis",
  {
    title: "Propose a new hypothesis",
    description:
      "Proposes a new, \"open\" hypothesis — a testable claim, not a fact. This NEVER confirms or promotes " +
      "anything; it only creates a candidate for a human to review later in the Chronicle app. If a similar open " +
      "hypothesis already exists, the existing one is returned instead of a duplicate.",
    inputSchema: {
      hypothese: z.string().describe("The claim itself, phrased neutrally"),
      verificatieCriteria: z.string().optional().describe("What would verify this"),
      bevestigingsCriteria: z.string().optional().describe("What would justify confirming this"),
      afwijzingsCriteria: z.string().optional().describe("What would justify rejecting this"),
      temporalText: z.string().optional().describe('Human-readable temporal scope, e.g. "since March 2026"'),
    },
  },
  async (input) => {
    try {
      return textResult(await memoryRequest("/hypotheses", { method: "POST", body: JSON.stringify(input) }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "add_evidence",
  {
    title: "Link evidence to a hypothesis",
    description:
      'Interprets one frozen episode as evidence for a hypothesis, in a direction: "supporting", "contradicting", ' +
      "or \"contextualizing\". Never touches the hypothesis's status — adding evidence, however conclusive, is " +
      "not the same act as a human confirming or rejecting it.",
    inputSchema: {
      hypothesisId: z.string(),
      episodeId: z.string(),
      richting: z.enum(["supporting", "contradicting", "contextualizing"]),
    },
  },
  async ({ hypothesisId, episodeId, richting }) => {
    try {
      return textResult(
        await memoryRequest(`/hypotheses/${encodeURIComponent(hypothesisId)}/evidence`, {
          method: "POST",
          body: JSON.stringify({ episodeId, richting }),
        })
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

// Ingestie Gateway over MCP — the official Gaia v3.0 dataflow: an MCP
// client (VS Code, Cursor, any agent) never writes directly to storage or
// to any reflection engine; it submits raw material through the typeward
// Ingestie Gateway (POST /api/ingest/*, see routes/ingest.js + ingestPolicy.js).
// Status is server-owned: everything below is stored as `observation`, and the
// gateway derives provider_conversation_id/content_hash itself, so a client
// can never fork dedup identity or claim an epistemic status. Retrying the
// same conversation upserts the same row instead of duplicating it.

server.registerTool(
  "ingest_snippet",
  {
    title: "Ingest a code snippet or note",
    description:
      "Submits a code snippet, error message, refactoring note or any other raw fragment to Foundation's " +
      "Ingestie Gateway (POST /api/ingest/document). It is stored as status \"observation\" — an immutable raw " +
      "source record, never a fact. A `source` naming the client/tool that captured it is required; status, ids " +
      "and hashes are refused (server-owned). Exact retries of the same URL upsert the same row instead of duplicating.",
    inputSchema: {
      content: z.string().describe("The snippet/text to store as a raw observation"),
      source: z.string().describe('Which tool/client submitted this, e.g. "vscode" or "cursor"'),
      title: z.string().optional().describe("Short title, e.g. the file name"),
      url: z.string().optional().describe("Origin URL — also anchors the dedup identity"),
      tags: z.array(z.string()).optional().describe("Labels, e.g. [\"vscode\", \"refactoring\"]"),
      occurredAt: z.string().optional().describe("ISO timestamp of when the captured content itself occurred"),
    },
  },
  async (input) => {
    try {
      const { content, source, ...rest } = input;
      return textResult(await ingestRequest("/document", { method: "POST", body: JSON.stringify({ content, source, ...rest }) }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "ingest_chat",
  {
    title: "Ingest an AI chat conversation",
    description:
      "Submits a full AI-chat conversation (e.g. with an IDE assistant) to Foundation's Ingestie Gateway " +
      "(POST /api/ingest/chat). Turns are allowed on this entry-point only. Stored as status \"observation\"; " +
      "providerConversationId/contentHash are derived server-side, so a re-submitted or grown conversation " +
      "upserts the same row (ON CONFLICT DO UPDATE) rather than duplicating.",
    inputSchema: {
      content: z.string().describe("The (flattened) conversation text"),
      turns: z.array(z.object({ role: z.string().optional(), text: z.string() })).optional().describe("Structured role/text turns, kept alongside the flattened content"),
      source: z.string().optional().describe('Capture channel, defaults to "chat-import"'),
      sourceProvider: z.string().optional().describe('Which provider the chat came from, e.g. "copilot"'),
      title: z.string().optional(),
      url: z.string().optional().describe("Origin URL — also anchors the dedup identity"),
      tags: z.array(z.string()).optional(),
      occurredAt: z.string().optional().describe("ISO timestamp of when the conversation occurred"),
    },
  },
  async (input) => {
    try {
      return textResult(await ingestRequest("/chat", { method: "POST", body: JSON.stringify(input) }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "ingest_activity",
  {
    title: "Ingest a session activity observation",
    description:
      "Logs one raw activity observation (e.g. \"worked on refactoring mcpServer.js\") to Foundation's Ingestie " +
      "Gateway (POST /api/ingest/capture — the desktop-capture entry-point). No turns, no sourceProvider: the " +
      "submitting tool ís the source, which is therefore required. Always stored as status \"observation\".",
    inputSchema: {
      content: z.string().describe("The activity observation to log"),
      source: z.string().describe('Which client/tool observed this, e.g. "vscode-extension"'),
      title: z.string().optional(),
      url: z.string().optional(),
      tags: z.array(z.string()).optional(),
      occurredAt: z.string().optional().describe("ISO timestamp of when the activity occurred"),
    },
  },
  async (input) => {
    try {
      return textResult(await ingestRequest("/capture", { method: "POST", body: JSON.stringify(input) }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// Read-side of the same pipe: what has reached Foundation through the
// gateway, and whether the async episode bridge has already frozen it —
// an observation-only mirror of the /ui ingest dashboard (routes/ingestLogs.js).

server.registerTool(
  "list_recent_ingests",
  {
    title: "List recently ingested objects",
    description:
      "Lists the most recent raw objects that reached Foundation via the Ingestie Gateway, each with its " +
      "server-owned status (always \"observation\" at intake), its providerConversationId (dedup identity) " +
      "and whether the async bridge has already frozen an episode from it (memory_processed_at). Read-only " +
      "diagnostics — influences nothing.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional().describe("Max rows (default 100)"),
    },
  },
  async ({ limit }) => {
    try {
      return textResult(await ingestLogsRequest(`/${limit ? `?limit=${limit}` : ""}`));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "get_ingest_object",
  {
    title: "Get one ingested object in full",
    description:
      "Full detail of one ingested object (its content, turns, server-derived content hash) plus the episodes " +
      "the bridge has frozen from it (bron_object_id \"ingest:<uuid>\"), each itself a frozen observation — " +
      "never an interpretation or fact. Read-only.",
    inputSchema: { id: z.string().describe("Ingest object id (see list_recent_ingests)") },
  },
  async ({ id }) => {
    try {
      return textResult(await ingestLogsRequest(`/${encodeURIComponent(id)}`));
    } catch (err) {
      return errorResult(err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[chronicle-memory MCP] listening on stdio, calling Chronicle at ${API_URL}`);
}

main().catch((err) => {
  console.error("[chronicle-memory MCP] fatal:", err);
  process.exit(1);
});
