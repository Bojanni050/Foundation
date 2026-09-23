# insight/ — HindsightProvider-alternatief (kandidaat, niet actief)

Deze module bevat het voormalige persona-subsysteem uit Foundation-Chronicle,
meegenomen in het extract (besluit 24 sep 2026) als Bo's eigen, epistemisch
gedisciplineerde voorloper van Insight.

**Status: kandidaat-zelfimplementatie áchter de HindsightProvider-abstractie.**
Geen derde geheugen naast Foundation en Hindsight — strategische reserve voor
het geval vectorize.io niet volstaat (geen hypothesis-status, geen
entrenchment, vendor-risico).

Wat hier al in zit en Insight nodig heeft:
- persona_kenmerk = gebruikersmodel mét statusmarkering, zekerheid, soort
  (feit/patroon), gevoeligheid, embeddings én provenance (bron_object_ids)
- computePromotion = entrenchment vóór de V3-review: promotie pas bij N
  onafhankelijke bronnen; feiten promoveren nooit automatisch door herhaling;
  confirmed alleen via de mens (assertStatusChangeAllowed = Absolute Override)
- "Heropstanding": een menselijk afgewezen patroon komt bij nieuw bewijs niet
  terug als feit, maar wórdt opnieuw aangeboden
- Temporele reflectie (validFrom/validTo/temporalText, supersession via
  vervangenDoor)

Let op: personaHelper.js staat (nog) op server-root omdat jobs.js
(auto-heal) hem nodig heeft; instelling-sliders (skepticism/literalism/empathy)
zijn de dispositie van de reflector — open punt of die in Gaia's SOUL thuishoren.
