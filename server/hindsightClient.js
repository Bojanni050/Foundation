// Hindsight-client — de reflectie-pijp tussen Foundation en Hindsight,
// server-zijde. Beide draaien op dezelfde VPS; Hindsight heeft geen eigen
// auth (Tailscale-lidmaatschap is de enige toegangscontrole, dezelfde
// posture als bij Gaia-Cloud's services/gaia-api — zie daar
// src/hindsightClient.js), dus dit is een plain HTTP-client zonder token.
//
// Scope is bewust klein: alleen wat de reflectie-pijp nodig heeft —
// retain (async) en een health-check. Recall blijft buiten beeld tot er
// een consumer is (typeward: geen dode API surface).
const DEFAULT_TIMEOUT_MS = 10000;

function createHindsightClient({ baseUrl, bankId, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const root = String(baseUrl || "").replace(/\/+$/, "");
  if (!root) throw new Error("HINDSIGHT_URL is vereist");
  if (!bankId) throw new Error("HINDSIGHT_BANK_ID is vereist");
  const bankUrl = (path = "") => `${root}/v1/default/banks/${bankId}${path}`;

  // Retain één item. Async opzettelijk: Hindsight draait zelf LLM-extractie
  // server-zijde (10-20s+); de pijp moet daar nooit op blokkeren — dit is
  // fire-and-forget met foutmelding in de logs.
  async function retain({ content, context, timestamp, documentId, tags, metadata }) {
    const item = {
      content,
      context: context || null,
      timestamp: timestamp || "unset",
      document_id: documentId || undefined,
      metadata: metadata || undefined,
      tags: tags || undefined,
    };
    let response;
    try {
      response = await fetchImpl(bankUrl("/memories"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ async: true, items: [item] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`hindsight retain onbereikbaar: ${error.message}`);
    }
    if (!response.ok) {
      throw new Error(`hindsight retain antwoordde ${response.status}`);
    }
  }

  // Bereikbaarheidscheck voor startBackgroundJobs: alleen verbinden als
  // Hindsight daadwerkelijk luistert, anders logt de pijp elke run een
  // fout terwijl er gewoon nog geen Hindsight op de VPS draait.
  async function healthy() {
    try {
      const response = await fetchImpl(`${root}/v1/health`, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(timeoutMs, 3000)),
      });
      return response.ok;
    } catch (_) {
      return false;
    }
  }

  return { retain, healthy, bankId };
}

module.exports = { createHindsightClient };
