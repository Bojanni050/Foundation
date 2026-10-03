### Gaia v3.0 Technical Integration Blueprint: IDE-to-Foundation via MCP

#### 1\. Strategic Architecture: The Foundation Hub

In the Gaia v3.0 paradigm, we distinguish fundamentally between agency and inference. The core maxim of this architecture is:  **"The conversation is the experience. Logos is the reflection on that experience."**  To maintain this, Gaia v3.0 treats the LLM as a "replaceable organ"—a transient cognitive instrument—while the Foundation (The Harness) serves as the persistent identity and "Soul."The Foundation layer acts as the critical  **"Stekkerdoos" (Power Strip)** , the singular epistemic Source of Truth. The mcpServer.js is the universal connector that brings the IDE into this ecosystem. Direct connectivity between IDEs (VS Code/Cursor) and Hindsight is strictly prohibited. This "Ingestion Pipe" integrity is maintained because raw activity must first be registered as "Observations" in Chronicle. Bypassing this via a direct Hindsight connection would cause "Epistemic Pollution," allowing raw data to corrupt the reflection layer.Furthermore, the IDE connection is governed by the  **HADES Rule** : as a sub-agent environment, the IDE has no persistent memory or initiative rights independent of the Foundation’s oversight.**Technical Data Flow & Epistemic Gatekeeping:**IDE (MCP Client) ↔ Foundation (MCP Server) ↔ Chronicle: Observation Chronicle → Hindsight: Interpretation → Adapter Layer (Status Force) → Logos: ReflectionThis modularity ensures that the system remains stable even as underlying models are swapped, keeping the human-validated context as the only permanent record.

#### 2\. The Epistemic Mandate: Data Status & Control

Gaia v3.0 is anchored in the  **"Absolute Override"**  philosophy. Meaning and authority reside exclusively with  **The Human (The Actor)** . To prevent AI hallucinations from hardening into false facts, the system enforces a binary status distinction at the infrastructure level.

* **Observation:**  The immutable source of truth (Chronicle). This includes literal code snippets, raw activity logs, and direct developer input.  
* **Interpretation:**  Fallible analytical translations or patterns derived by Hindsight. These are working hypotheses, not objective facts.The  **Adapter Layer**  serves as the technical gatekeeper on the Hindsight-Logos boundary. It is programmatically required to force the "interpretation" status on all data retrieved from Hindsight. Any tool recalling this context must include the mandatory epistemic warning:  "Dit is een afgeleid patroon, geen bevestigd feit." This ensures that the Actor is always aware when they are interacting with an AI-derived assumption rather than a confirmed observation.

#### 3\. Tooling Standard: The Foundation MCP Toolset

The mcpServer.js exposes four functional categories. These tools are the only permissible interface for the IDE to interact with Gaia’s cognitive layers.

##### Category 1: Ingestion Tools (Write-Actions)

These tools register raw data into Chronicle.

* foundation\_ingest\_snippet: Saves code fragments or error logs.  
* **LLM MANDATE:**  You MUST set status: "observation" for every call.  
* foundation\_save\_note: Saves explicit developer decisions or architectural TODOs.  
* foundation\_log\_activity: Logs session events (e.g., "Refactoring mcpServer.js").  
* **LLM MANDATE:**  You MUST set status: "observation" without exception.

##### Category 2: Retrieval & Context (Read-Actions)

These tools provide the context for AI-assisted coding.

* foundation\_search\_knowledge: Performs hybrid search across historical notes and chats.  
* foundation\_recall\_context: Retrieves Hindsight patterns.  
* **LLM MANDATE:**  You MUST treat all results as interpretation and display the mandatory warning:  *"Dit is een afgeleid patroon, geen bevestigd feit."*  
* foundation\_get\_decision\_log: Retrieves only  **confirmed**  (promoted) architectural decisions. This bridges the gap between Interpretation and Observation via the Absolute Override.

##### Category 3: Epistemic & Assessment (Override)

These tools enable the Human Actor to exert control over Gaia's internal models.

* foundation\_list\_hypotheses: Overviews active patterns awaiting human validation.  
* foundation\_validate\_hypothesis: The technical implementation of the  **Absolute Override** . Allows the Human to confirm or reject AI-derived patterns.

##### Category 4: Session & Workspace

These tools structure the development narrative.

* foundation\_session\_start: Marks the start of a task context.  
* foundation\_session\_end: Closes the session and triggers asynchronous Logos reflection.  
* foundation\_bind\_workspace: Links the current directory to a specific project context.

#### 4\. Implementation Guide: Scripts and Configuration

Standardization of the boot process is required to ensure database migrations (via Drizzle) and TypeScript compilations are handled before the IDE client attempts a connection.

##### Foundation MCP Boot Script (scripts/dev-mcp.sh)

\#\!/usr/bin/env bash  
\# Ensure environment readiness for the Foundation MCP Server  
set \-e

PROJECT\_ROOT="\$(cd "\$(dirname "\${BASH\_SOURCE}")" && cd .. && pwd)"  
cd "\$PROJECT\_ROOT"

echo "🔍 \[Foundation MCP\] Checking dependencies..."  
\[ \! \-d "node\_modules" \] && npm install

echo "🗄️ \[Foundation MCP\] Synchronizing Database..."  
npx drizzle-kit migrate || { echo "❌ Migration failed"; exit 1; }

echo "🛠️ \[Foundation MCP\] Compiling Logic..."  
npx tsc \--noEmit

echo "🚀 \[Foundation MCP\] Launching Server (Stdio)..."  
exec npx tsx services/foundation/mcpServer.js

##### IDE Configuration Blocks

###### *Visual Studio Code (Roo Code / Cline / Continue)*

Add to your MCP settings JSON:  
{  
  "mcpServers": {  
    "foundation": {  
      "command": "/bin/bash",  
      "args": \["\${workspaceFolder}/scripts/dev-mcp.sh"\],  
      "env": {  
        "NODE\_ENV": "production",  
        "DATABASE\_URL": "file:\${workspaceFolder}/data/chronicle.db"  
      },  
      "autoApprove": \[  
        "foundation\_search\_knowledge",  
        "foundation\_recall\_context"  
      \]  
    }  
  }  
}

###### *Cursor Configuration*

In .cursor/mcp.json or Global MCP Settings:  
{  
  "mcpServers": {  
    "foundation-mcp": {  
      "command": "node",  
      "args": \["\${workspaceFolder}/services/foundation/mcpServer.js"\],  
      "env": {  
        "NODE\_ENV": "production",  
        "DATABASE\_URL": "file:\${workspaceFolder}/data/chronicle.db"  
      }  
    }  
  }  
}

#### 5\. Operational Protocol: The Developer Workflow

The integration of Gaia v3.0 transforms the IDE into a medium for  **Reflective Intelligence** . We follow a retrospective intelligence loop:  **"Intelligence is created by learning from what happens in the path, not by adding stages to it."**

1. **Task Initiation:**  The developer triggers foundation\_session\_start. This allows Gaia to group incoming observations without adding synchronous reasoning latency to the live turn.  
2. **Active Coding & Ingestion:**  During development, the IDE uses foundation\_ingest\_snippet. These are stored as  **Observations**  (Facts), preserving the raw experience.  
3. **Context Retrieval:**  When the developer seeks guidance, the AI uses foundation\_recall\_context. The system surfaces Hindsight patterns, strictly labeled as  **Interpretations**  to prevent identity drift or unearned assumptions.  
4. **Absolute Override:**  The developer reviews surfaced hypotheses using foundation\_validate\_hypothesis. By confirming or rejecting patterns,  **The Human (The Actor)**  directs the cognitive evolution of the system.  
5. **Asynchronous Reflection:**  Upon foundation\_session\_end, the Logos faculty analyzes the session in the background. This asynchronicity ensures the coding experience remains fast while building intelligence retrospectively.This strategy ensures the IDE functions as a lifelong cognitive partner, where every keystroke contributes to a growing, human-validated understanding while maintaining absolute epistemic truth.

