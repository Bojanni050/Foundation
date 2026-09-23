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

function mapIngestRowToEpisodeInput(row) {
  const sourceType = SOURCE_TYPE_BY_OBJECT_TYPE[row.object_type];
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
