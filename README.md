# Website Check

Privédashboard voor wijzigingen op Shopify- en WooCommerce/WordPress-websites. De eerste website is `https://bonoir.nl/`.

## Wat een scan doet

- Haalt de homepage en XML-sitemaps op en bewaart ontdekte pagina's.
- Controleert per run maximaal 30 pagina's. Bij grotere sites schuift de scan verder door de sitemap, zodat de dekking zichtbaar en voorspelbaar blijft.
- Bewaart per pagina HTTP-status, laadtijd, zichtbare tekst, HTML, titel, metabeschrijving, gedetecteerde prijzen en CSS/script-referenties als hashes en samenvattingen.
- Noteert wijzigingen na de eerste nulmeting en vergelijkt gevonden levertermijnen, besteldeadlines, verzendkosten en drempels voor gratis verzending tussen gecontroleerde pagina's.
- Bewaart de geschiedenis en instellingen in de `BUCKET` R2-binding van de privé-Site.

Een scan is een steekproef op de ingestelde momenten, geen continue uptimebewaking. Dynamische winkelwagen, checkout, ingelogde pagina's en JavaScript-gerenderde inhoud vallen buiten deze eerste versie. Een CSS-wijziging op dezelfde asset-URL is alleen zichtbaar als de pagina-HTML mee verandert.

## Codex-cloudtaak

De Site publiceert een MCP-tool op `/mcp`. Verbind de door Sites aangeboden privéplugin met Codex. Een geplande taak roept om 08:00 en 20:00 (Europe/Amsterdam) `website_check_scan_due` aan, en daarna `website_check_status`. De eerste run maakt de nulmeting. Bij een fout of betekenisvolle wijziging meldt Codex dit; zonder verandering blijft de taak stil.

De tool `website_check_scan_due` gebruikt per website de instelling van één of twee scans per dag. Een website met één scan per dag wordt tijdens de tweede run overgeslagen. Een handmatige scan kan in het dashboard of met `website_check_scan_site`.

De cloudtaak moet de Site en de MCP-koppeling opnieuw openen; er zijn geen API-sleutels in de broncode of taakprompt nodig. De Site zelf haalt openbare pagina's met standaard HTTP-verzoeken op. De OpenAI API wordt niet aangeroepen.

## Broncode

`worker/index.js` bevat de Cloudflare Worker en het dashboard. `npm run check` controleert de JavaScript-syntax; `npm run build` maakt het Sites-artefact in `dist/`.
