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
