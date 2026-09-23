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

async function memoryRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_URL}/api/memory${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
  } catch (err) {
    throw new Error(`Chronicle server unreachable at ${API_URL} — is it running? (${err.message})`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[chronicle-memory MCP] listening on stdio, calling Chronicle at ${API_URL}`);
}

main().catch((err) => {
  console.error("[chronicle-memory MCP] fatal:", err);
  process.exit(1);
});
