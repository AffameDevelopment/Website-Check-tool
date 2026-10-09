# Website Check

Privédashboard voor openbare Shopify- en WooCommerce/WordPress-webshops. De eerste website is `https://bonoir.nl/`. De live Site en de geplande Codex-taak gebruiken de JavaScript Worker in `worker/index.js`; de oorspronkelijke Python-scanner blijft beschikbaar als losse lokale variant.

## Online dashboard

De Site bewaart instellingen en geschiedenis in haar R2-opslag. Voeg websites toe in het dashboard en kies één of twee controles per dag. Een scan leest de homepage, verzend/FAQ-links en XML-sitemaps, en controleert maximaal 30 pagina's per run. Bij grotere sites schuift hij bij de volgende run verder door de sitemap.

Per pagina worden HTTP-status, laadtijd, tekst, HTML, titel, metabeschrijving, prijzen, verzendclaims en CSS/script-referenties vergeleken. De eerste scan legt een nulmeting vast. Latere scans tonen wijzigingen en mogelijke tegenstrijdigheden tussen pagina's. De Site heeft geen OpenAI API-sleutel en roept de OpenAI API niet aan.

## Geplande Codex-taak

De gekoppelde taak draait om 08:00 en 20:00 in `Europe/Amsterdam`. Zij roept `website_check_scan_due` en daarna `website_check_status` op via de privé-Siteplugin. De Site bepaalt per website of die run nodig is. Codex meldt betekenisvolle wijzigingen, tegenstrijdige verzendclaims en fouten; zonder verandering blijft de taak stil.

De Siteplugin moet in Codex verbonden zijn. De taak gebruikt geen API-sleutel in de broncode of prompt. Gebruik de knop **Nu controleren** in het dashboard voor een handmatige nulmeting.

## Lokale Python-variant

De bestaande scanner kan zonder extra Python-pakketten worden gebruikt:

```bash
python3 monitor.py scan
python3 -m http.server 8000
```

Open `http://localhost:8000/dashboard.html`. Deze variant schrijft naar `data/state.json` en heeft een eigen `sites.json`. Die bestanden zijn niet gekoppeld aan de online Site.

## Ontwikkeling

`npm run check` controleert de syntax van de Worker. `npm run build` maakt het Site-artefact in `dist/`. De Python-variant heeft aparte controles met `python3 -m unittest`.

## Grenzen

De controles vinden één of twee keer per dag plaats en zijn geen continue uptimebewaking. Checkout, ingelogde pagina's en inhoud die pas na JavaScript-uitvoering verschijnt worden niet volledig gemeten. CSS-wijzigingen op dezelfde asset-URL zijn alleen zichtbaar als de pagina-HTML mee verandert. Verzendclaims worden automatisch herkend; controleer gemelde tegenstrijdigheden handmatig. Het aantal bezochte pagina's staat in het dashboard, zodat beperkte dekking zichtbaar is.
