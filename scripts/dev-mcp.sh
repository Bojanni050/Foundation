#!/usr/bin/env bash
# Foundation MCP dev-startup: check dependencies, apply DB migrations, then
# start the Chronicle MCP server (server/mcpServer.js) over stdio. Point an
# MCP client (VS Code .vscode/mcp.json, Cursor .cursor/mcp.json) at this
# script so migrations always run before the server connects.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

echo "🔎 [Foundation MCP] Checking environment and dependencies..."

if [ ! -d "server/node_modules" ]; then
  echo "⚠️ server/node_modules not found. Installing..."
  (cd server && npm install)
fi

if [ -f "db/drizzle.config.ts" ] || [ -f "db/drizzle.config.json" ]; then
  echo "🗄️ [Foundation MCP] Applying database migrations..."
  (cd db && npx drizzle-kit migrate)
fi

echo "🚀 [Foundation MCP] Starting MCP server over stdio..."
exec node server/mcpServer.js
