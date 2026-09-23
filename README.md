# Foundation

**Opslag + epistemiek + één API — de stekkerdoos.** Foundation is hét geheugen:
de enige epistemische bron ("dit is geregistreerd"). Alle clients pluggen hier
in via één API; `mcpServer.js` maakt alle MCP-clients (incl. AI-agents)
inplugbaar.

```
Capture RS (repo: capture-rs) · Diary-opnames · chatgpt-imports · ...
                        ↓ Ingestie Gateway (/api/ingest/*, status = observation)
             FOUNDATION  (opslag + epistemiek + API)
                        ↑ één API (mcpServer.js)
Clients:  Chronicle (notes/zoek/validatie-UI) · Gaia (geest, via Insight/Logos)
```

## Extract uit Foundation-Chronicle (25 sep 2026)

Schone repo volgens het "ruit de core eruit, laat de troep liggen"-recept.
Foundation-Chronicle blijft ongewijzigd als archief liggen.

**Meegevallen:**
- Epistemiek: epistemicPolicy, statusPromotion, episodePolicy, retrievalPolicy,
  memoryIntegrity, memoryMaintenance + tests
- Import: chatgptImportManager + route
- Opslag: db.js + db/ (Drizzle, incl. migrations), contentHash, embedding
- Server: slanke index.js (Hermes/4579-route en connectors weg), auth,
  routes (memory, attachments, settings, embedding, chatgptImport)
- mcpServer.js + test
- `insight/`: het persona-subsysteem als HindsightProvider-alternatief
  (kandidaat, niet actief — zie server/insight/README.md)

**Bewust níet meegenomen (blijft in het archief):** persona-frontend
(PersonaDialog), Python memory/-laag (Hermes-fossiel), de Hermes-kabel
(poort 4579), connectors-route (WordPress-erfgoed), Capacities-frontend.

**Bruggetje (tijdelijk):** het oude inbox/memory-process-patroon
(inboxStore, captureActivityLog, /api/inbox, memory-process sidecar) blijft
aangezet omdat het geweven zit in de import-flow. De Ingestie Gateway is nu
gebouwd (zie hieronder); zodra de import-flow en clients op /api/ingest/*
zitten, verdwijnt het bruggetje.

## Ingestie Gateway (25 sep 2026)

Server-side ingest-route — de officiële pijp voor alle externe bronnen.
Typeward entry-points (Lumina-les): per bron een eigen endpoint met een
exact veldcontract (vereist/toegestaan/geweigerd), gevalideerd in de pure
module `server/ingestPolicy.js` (+ test):

- `POST /api/ingest/chat` — AI-chats (turns toegestaan)
- `POST /api/ingest/capture` — desktop-capture (geen turns; source vereist)
- `POST /api/ingest/document` — expliciet gedeelde documenten (source vereist)
- `POST /api/ingest/diary` — audio/video-log (transcript-turns toegestaan)
- `GET /api/ingest/recent` — diagnostiek (laatste 50)

Regels die in code worden afgedwongen, niet in prompts:

1. **status is server-owned**: alles komt binnen als `observation`; een
   client die een status meestuurt krijgt 422 (Absolute Override — vertrouwen
   komt uitsluitend via menselijke validatie).
2. **providerConversationId/contentHash worden server-side afgeleid** —
   dedup-identiteit kan niet gevorkt worden. Dezelfde conversatie die opnieuw
   of via een tweede kanaal binnenkomt updatet dezelfde rij (ON CONFLICT DO
   UPDATE) in plaats van te dupliceren.
3. **Onbekende velden = 422** (exact contract, geen stille drop).

Opslag: tabel `ingest_object` (Drizzle-migratie 0019). Geen ruisfilter hier —
dat zit aan de capture-kant; Foundation registreert wat de pijp bereikt.

## Databases-beleid

Één epistemische bron. Alles daarbuiten is buffer (Capture RS: herstart = leeg
is oké), cache (Hindsight: herbouwbaar mét provenance) of vendor-intern.
Chronicle start op 0 — geen V1-backfill.

## Draaien

```
cd db && docker compose up -d && npm install && npx drizzle-kit migrate
cd server && npm install && npm start   # index.js + memory-process sidecar
```
