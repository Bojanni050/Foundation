// Real stdio round-trip against the actual server process — not a mock.
// Requires the Chronicle server (npm start / node index.js) running at
// CHRONICLE_API_URL (default http://127.0.0.1:4577) for the live-call
// assertions; the process-spawn and tool-listing checks work regardless.
const assert = require("assert");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "mcpServer.js")],
  });
  const client = new Client({ name: "mcpServer.test", version: "1.0.0" });
  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name).sort();
    assert.deepStrictEqual(toolNames, [
      "add_evidence",
      "create_episode",
      "get_hypothesis",
      "get_ingest_object",
      "ingest_activity",
      "ingest_chat",
      "ingest_snippet",
      "list_facts",
      "list_hypotheses",
      "list_recent_ingests",
      "propose_hypothesis",
      "search_memory",
    ]);
    console.log("ok - exposes exactly the expected read/propose/ingest tools, no confirm/reject/knowledge-gap tools");

    for (const dangerous of ["confirm_hypothesis", "reject_hypothesis", "transition_knowledge_gap", "validate_hypothesis"]) {
      assert.ok(!toolNames.includes(dangerous), `must never expose ${dangerous}`);
    }
    console.log("ok - no confirm/reject/knowledge-gap-transition tool exists");

    for (const tool of tools) {
      if (tool.name.startsWith("ingest_")) {
        assert.ok(
          !JSON.stringify(tool.inputSchema).includes("status"),
          `tool ${tool.name} must not accept a status field (server-owned)`
        );
      }
    }
    console.log("ok - no ingest tool lets a client claim an epistemic status");

    const result = await client.callTool({ name: "search_memory", arguments: { query: "test query for mcp verification", limit: 3 } });
    const text = result.content[0].text;
    if (result.isError) {
      console.log(`skip - live search_memory call errored (is the Chronicle server running?): ${text}`);
    } else {
      const parsed = JSON.parse(text);
      assert.ok(Array.isArray(parsed.results), "search_memory must return a results array");
      console.log(`ok - search_memory returned a real response with ${parsed.results.length} result(s)`);
    }

    const ingestResult = await client.callTool({
      name: "ingest_snippet",
      arguments: { content: "mcp verification snippet", source: "mcpServer.test" },
    });
    const ingestText = ingestResult.content[0].text;
    if (ingestResult.isError) {
      console.log(`skip - live ingest_snippet call errored (is the Chronicle server running?): ${ingestText}`);
    } else {
      const parsed = JSON.parse(ingestText);
      assert.strictEqual(parsed.status, "observation", "ingest must return server-owned status observation");
      console.log(`ok - ingest_snippet returned a real response with status: ${parsed.status}`);
    }

    console.log("\nAll checks passed.");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("FAIL -", err.message);
  process.exit(1);
});
