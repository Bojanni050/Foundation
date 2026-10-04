// Pure mapping van de velden die capture-rs op de ingest_object-rij achterlaat
// naar de app/venster-as die een consument (Kairos) nodig heeft om observaties
// te clusteren op contextswitch.
//
// Waarom dit bestaat: capture-rs stuurt titel "app — venster" en tags ["app"]
// mee (src/ship.rs), maar de ingest-bridge bewaart alléén de tekst in
// episode.fragment — app en venstertitel blijven op ingest_object staan. De
// rauwe episode is (terecht) tekst-only; dit legt de brug terug naar de
// context zonder iets aan de bevroren observatie te veranderen.
//
// Geen DB, geen clock: volledig unit-testbaar, zelfde conventie als
// ingestBridgeMapping.js. Alles is best-effort — een ontbrekende titel is
// null, nooit een gok.

// Het scheidingsteken dat capture-rs zelf gebruikt: format!("{} — {}", app, title)
// (em-dash met spaties eromheen, zie src/ship.rs to_payload).
const TITLE_SEPARATOR = " — ";

/**
 * Splitst een ingest_object-titel in { app, windowTitle }.
 * "Outlook — Postvak IN" -> { app: "Outlook", windowTitle: "Postvak IN" }
 * "Outlook"              -> { app: "Outlook", windowTitle: null }
 * null/""                -> { app: null, windowTitle: null }
 * @param {unknown} title
 * @returns {{ app: string|null, windowTitle: string|null }}
 */
function splitTitledApp(title) {
  if (typeof title !== "string") return { app: null, windowTitle: null };
  const trimmed = title.trim();
  if (!trimmed) return { app: null, windowTitle: null };
  const idx = trimmed.indexOf(TITLE_SEPARATOR);
  if (idx === -1) return { app: trimmed, windowTitle: null };
  const app = trimmed.slice(0, idx).trim();
  const windowTitle = trimmed.slice(idx + TITLE_SEPARATOR.length).trim();
  return { app: app || null, windowTitle: windowTitle || null };
}

/**
 * Leidt de app-as van een episode-rij af. Voorkeur voor de expliciete tag
 * (capture-rs zet de app unaniem als eerste tag) boven de titel-split, want de
 * tag is niet afhankelijk van een scheidingsteken dat in de titel zelf kan
 * voorkomen.
 * @param {unknown} tags  ingest_object.tags (text[])
 * @param {unknown} title ingest_object.title
 * @returns {string|null}
 */
function observedAppFromRow(tags, title) {
  if (Array.isArray(tags)) {
    const first = tags.find((t) => typeof t === "string" && t.trim());
    if (first) return first.trim();
  }
  return splitTitledApp(title).app;
}

/**
 * Verrijkt één episode-rij (zoals de read-seam die teruggeeft, met de
 * ingest_object-kolommen die de JOIN meebrengt) met de afgeleide app-as.
 * Alleen-lezen afleiding — de episode-velden zelf blijven onaangeroerd.
 * @param {object} row
 * @returns {object}
 */
function decorateEpisodeWithApp(row) {
  if (!row || typeof row !== "object") return row;
  const { app, windowTitle } = splitTitledApp(row.source_title);
  const observedApp = observedAppFromRow(row.source_tags, row.source_title);
  const { source_title: _t, source_tags: _g, ...rest } = row;
  return {
    ...rest,
    observed_app: observedApp,
    observed_window: windowTitle,
  };
}

module.exports = {
  TITLE_SEPARATOR,
  splitTitledApp,
  observedAppFromRow,
  decorateEpisodeWithApp,
};
