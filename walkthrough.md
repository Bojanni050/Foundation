# Walkthrough — Foundation

## 2026-10-05 (Bulk-importer-erfenis verwijderd)

- Findings:
  - Foundation bevatte een server-side bulk-importeur die ChatGPT/Gemini via
    Playwright en Claude via export-zip importeerde (`tools/chatgpt_bulk_import/`,
    `server/chatgptImportManager.js`, `server/routes/chatgptImport.js`, plus de
    mount in `server/index.js`). Git-historiek (`6c9fad5`, 25 sep 2026) toont dat
    dit erfgoed is van de ontmanteling van het gecombineerde
    Foundation-Chronicle-prototype — "Import: chatgptImportManager + route" stond
    letterlijk in de "meegevallen core".
  - Dat is capture-logica aan de ontvangende kant en botst met
    `Gaia-Documentation/capture-chronicle.md`: de capture-kant filtert en bepaalt
    wat "een chat" is; Foundation registreert alleen wat de officiële pijp bereikt.
- Conclusions:
  - Besluit (gebruiker): de erfenis mag weg; Chronicle-Gaia is de enige
    capture-path. Verwijderd nadat de Chronicle-route live bewezen was
    (idempotentie 201→200, per-bron dedup via url), zodat er geen gat viel.
  - Alleen de importeur is weg; de Ingestie Gateway, het veldcontract
    (`ingestPolicy.js`) en de dedup-afleiding (`providerConversationId.js`)
    blijven ongewijzigd — dat is de eigenlijke ontvangst.
- Actions:
  - `git rm`: `tools/chatgpt_bulk_import/**`, `server/chatgptImportManager.js`,
    `server/routes/chatgptImport.js`.
  - `server/index.js`: require + mount `/api/settings/chatgpt-import` verwijderd.
  - Commentaar/tekst bijgewerkt: `routes/ingest.js`, `ingestPolicy.js`,
    `providerConversationId.js`, `public/settings.html`, `README.md`,
    `DEPLOYMENT.md` (incl. "meegevallen" vermelding → verplaatst naar een
    "verwijderd"-noot).
  - Validatie: `node --check` op de gewijzigde modules; `npm test` in `server/`
    → alle 19 testbestanden geslaagd; losse require-check van de route-modules
    zonder de verwijderde imports → ok.
