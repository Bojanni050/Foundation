# Foundation

**Opslag + epistemiek + één API — de stekkerdoos.** Foundation is hét geheugen:
de enige epistemische bron ("dit is geregistreerd"). Alle clients pluggen hier
in via één API; `mcpServer.js` maakt alle MCP-clients (incl. AI-agents)
inplugbaar.

```
Capture RS (repo: capture-rs) · Diary-opnames · chatgpt-imports · ...
                        ↓ Ingestie Gateway (nog te bouwen: server-side ingest-route)
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
aangezet omdat het geweven zit in de import-flow. Het wordt vervangen zodra
de échte server-side ingest-route er is (bouwstap: Ingestie Gateway, met
statusmarkering observation bij binnenkomst).

## Databases-beleid

Één epistemische bron. Alles daarbuiten is buffer (Capture RS: herstart = leeg
is oké), cache (Hindsight: herbouwbaar mét provenance) of vendor-intern.
Chronicle start op 0 — geen V1-backfill.

## Draaien

```
cd db && docker compose up -d && npm install && npx drizzle-kit migrate
cd server && npm install && npm start   # index.js + memory-process sidecar
```
