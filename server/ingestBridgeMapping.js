// Pure mapping ingest_object-rij → episode-input. Geen DB, geen requires met
// side effects — daardoor volledig unit-testbaar (ingestBridge.test.js).
//
// Epistemisch uitgangspunt (Manifest §5): een episode is zélf een bevroren
// observatie. Deze mapping herschrijft of interpreteert niets — content gaat
// verbatim als fragment in. object_type → sourceType is een vaste
// vertaaltabel; een onbekend object_type faalt luid (typeward), zodat een
// nieuw Gateway-type nooit stilletjes een verkeerd episode-soort krijgt.

const SOURCE_TYPE_BY_OBJECT_TYPE = {
  chat: "chat-import",
  document: "document",
  diary: "explicit-input",
  capture: "system-observation",
};

// Web-clips enter through the chat entry-point (a page has no provider
// conversation), so object_type alone would label them chat-import. Their
// provenance lives in source_provider; keep that distinction instead of
// flattening a clipped page into an AI-chat import.
const WEB_SOURCE_PROVIDER = "web";

function mapIngestRowToEpisodeInput(row) {
  const isWebClip =
    row.object_type === "chat" &&
    typeof row.source_provider === "string" &&
    row.source_provider.trim().toLowerCase() === WEB_SOURCE_PROVIDER;
  const sourceType = isWebClip
    ? "web"
    : SOURCE_TYPE_BY_OBJECT_TYPE[row.object_type];
  if (!sourceType) {
    throw new TypeError(
      `no episode sourceType mapping for object_type "${row.object_type}"`
    );
  }
  return {
    // Volledig traceerbaar terug naar de Gateway-rij: hetzelfde id dat
    // /api/ingest teruggeeft, en waar /api/memory/sources/:bronObjectId/usage
    // de afgeleide kennis mee terugvindt.
    bronObjectId: `ingest:${row.id}`,
    bronsoort: row.object_type,
    fragment: row.content,
    observedAt: row.occurred_at ?? row.ingested_at,
    bronReferentie: row.url ?? null,
    conversationIdentity: row.provider_conversation_id ?? null,
    sourceType,
  };
}

module.exports = { SOURCE_TYPE_BY_OBJECT_TYPE, mapIngestRowToEpisodeInput };
