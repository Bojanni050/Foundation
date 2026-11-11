# Walkthrough — Foundation

## 2026-10-05 (Blob-store voor bronbestanden — eigenaar van het origineel)

- Findings:
  - Besluit (gebruiker): Foundation is de **eigenaar** van het originele
    exportbestand; Chronicle houdt een identieke byte-for-byte kopie. Het hele
    bestand gaat als één blob naar Foundation; daarnaast stuurt Chronicle elk
    geparseerd gesprek rauw als chat.
  - De blob is het "ultieme bewijs": omdat het origineel bewaard blijft, is elke
    ontledingskeuze aan de capture-kant herleidbaar en herhaalbaar.
  - Foundation had nog geen blob-store: alleen de DB-content-kolom en de
    attachments-opslag (random-id, 25MB-limiet, voor afbeeldingen). Een bronblob
    kan honderden MB's zijn en hoort niet in `content`.
- Conclusions:
  - Nieuwe content-addressed blob-store op sha256, **tweeledig** (Local nu, S3
    als tweede implementatie van dezelfde interface; backend via config). De
    bytes staan op schijf, alleen identiteit + provenance in de DB.
  - Bronbestand hangt aan een `document`-observatie in ingest_object (metadata),
    met de bytes in de blob-store. Foundation interpreteert niets; het
    registreert.
- Actions:
  - Nieuw `server/blobStore.js` (+ `blobStore.test.js`, 6 tests): `LocalBlobStore`
    (sha256-identiteit, add-only, idempotent, provenance), `S3BlobStore`-seam,
    `createBlobStore(env)`.
  - Nieuw `server/routes/sourceFiles.js` (`POST /api/source-files`, raw body,
    512MB-limiet; `GET /api/source-files/:hash` read-only), gemount in
    `server/index.js`.
  - Nieuw `db/migrations/0025_add_source_blob.sql` + schema (`source_blob`-tabel)
    + journal-entry. Migratie bewezen toegepast in een wegwerp-schema op de VPS
    (kolommen/types kloppen), daarna opgeruimd.
  - Validatie: volledige `server/`-suite → 20 testbestanden geslaagd;
    `node --check` + require-check ok.
  - Live tegen de VPS: blob met sha256 `56ffe09b…` correct opgeslagen en
    terugleesbaar; idempotent (tweede POST `200`/`reused:true`). Bevinding: de
    globale `express.json()` vóór de raw-route gaf 400 op JSON-gelabelde bodies
    → skip voor `/api/source-files`; en een herlevering maakte een tweede
    document-observatie → nu idempotent op sha256 (zelfde `ingestObjectId`).
    Beide gefixt en opnieuw bewezen (`8867547f…`: 201 → 200, zelfde id).
  - Alle test-observaties, -episodes en -blobs daarna opgeruimd (trigger terug op `O`).

## 2026-11-06 (Episode-source `web` voor web-clips)

- Findings:
  - Chronicle-Gaia levert web-clips via `POST /api/ingest/chat` met
    `sourceProvider: "web"` (het archiveert ze lokaal als type `web`). Foundation
    kent alleen het `object_type` (`chat`) en maakte er daardoor een
    `chat-import`-episode van; de herkomst "geknipte webpagina" ging verloren.
  - De episode-source-enum (`episode_source_type`) had geen `web`, terwijl
    `episodePolicy.test.js` die waarde juist als ongeldig voorbeeld gebruikte.
- Conclusions:
  - `web` is een eigen episode-source, geen AI-chat-import. De brug moet hem
    daarom afleiden uit `source_provider` (alleen bij `object_type: chat`) in
    plaats van uit `object_type` alleen — zonder de bestaande object_type-map
    te veranderen.
  - Enum uitbreiden met een `ALTER TYPE ... ADD VALUE IF NOT EXISTS`, zodat de
    migratie idempotent is en bestaande episodes onaangeroerd blijven.
- Actions:
  - `db/schema.ts` + `server/episodePolicy.js` + `server/mcpServer.js`
    (`create_episode`-zod): `web` toegevoegd aan de source-opties.
  - Nieuw `db/migrations/0026_add_web_episode_source_type.sql` + journal-entry.
  - `server/ingestBridgeMapping.js`: chat-rij met `source_provider = web`
    → `sourceType: "web"`; overige object_types ongewijzigd.
  - Tests: `episodePolicy.test.js` (web geldig, `webpage` ongeldig) en
    `ingestBridge.test.js` (web-clip → web-episode). Volledige
    `server/`-suite: 20 testbestanden geslaagd.
  - Migratie nog niet toegepast op een database; `IF NOT EXISTS` maakt
    herhaling veilig.

## 2026-11-11 (Dual-bind 4577: loopback + tailnet tegelijk)

- Findings:
  - "Foundation draait niet meer op Contabo" bleek geen procesprobleem:
    pm2 `chronicle` draaide gezond. Sinds de beveiligingsfix van 5 nov
    (publieke chronicle-db) staat `CHRONICLE_HOST=100.65.0.15` in
    `/opt/Foundation/.env`, en `server/index.js` bond toen **alléén** dat
    ene interface. `127.0.0.1:4577` gaf op de VPS zelf connection refused.
  - Alles wat via loopback praat viel daardoor om: de `foundation`-MCP
    (`opencode.json`, `CHRONICLE_API_URL=http://127.0.0.1:4577`) gaf
    "Chronicle server unreachable", de rook-test (DEPLOYMENT §5) faalde,
    SSH-tunnels naar loopback waren nutteloos. Buitenom (tailnet) bleef
    `http://100.65.0.15:4577` wél bereikbaar.
- Conclusions:
  - Binden op **beide** interfaces in plaats van één: loopback altijd,
    plus CHRONICLE_HOST als die gezet is. Twee listeners op dezelfde poort
    mag (verschillende adressen), en 0.0.0.0 blijft verboden.
  - Een mislukte extra binding (tailnet-IP nog niet up bij boot) mag de
    loopback-listener niet mee laten vallen: loggen en doorgaan.
- Actions:
  - `server/index.js`: `app.listen(PORT, "127.0.0.1")` als primaire
    listener; bij een niet-loopback `CHRONICLE_HOST` een tweede listener op
    hetzelfde poortnummer, met eigen error-handler die de crash opvangt en
    alleen de extra binding opgeeft. `shutdown` sluit nu beide.
  - `opencode.json`: `CHRONICLE_API_URL` → `http://100.65.0.15:4577`
    (werkt op de VPS én via Tailscale vanaf Bo's pc).
  - Validatie: `node --check` + volledige `server/`-suite (20
    testbestanden geslaagd); op de VPS na deploy beide bindings bewezen
    via `ss` en curl op beide adressen.
