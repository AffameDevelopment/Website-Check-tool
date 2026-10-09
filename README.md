# Website Check

Een eerste versie voor openbare Shopify- en WooCommerce/WordPress-webshops. De scanner werkt met Python 3.12 of nieuwer en gebruikt geen OpenAI API of extra Python-pakketten.

## Gebruik

```bash
python3 monitor.py add https://voorbeeldwinkel.nl --name "Voorbeeldwinkel" --frequency 2
python3 monitor.py scan
python3 -m http.server 8000
```

Open daarna lokaal `http://localhost:8000/dashboard.html`. Met `--frequency 1` wordt een winkel één keer per dag gecontroleerd; de standaard is twee keer per dag. Plan `python3 monitor.py scan --due` om 09:00 en 21:00 Europe/Amsterdam. De scanner slaat reeds uitgevoerde tijdvakken per winkel over. Met `--max-pages 200` stel je het maximum aantal pagina's voor een winkel in. Pas `sites.json` aan voor een andere vertraging, tijdzone of frequentie.

De eerste scan is een nulmeting. Latere scans tonen gewijzigde titels, prijzen, zichtbare tekst, thema's, verzendkosten en levertijden. Het overzicht toont ook bereikbaarheid, HTTP-fouten en mogelijke tegenstrijdigheden tussen pagina's. De scanner gebruikt sitemap en interne links, volgt `robots.txt` en leest alleen openbare HTML. De uitkomsten staan in `data/state.json`; het statische overzicht staat in `dashboard.html`. Bewaar beide bestanden tussen runs, anders is vergelijken onmogelijk.

## Terugkerende Codex-taak

Maak in Codex, als de functie voor geplande taken beschikbaar is, een taak voor deze repository om 09:00 en 21:00 in de gewenste tijdzone. Gebruik deze opdracht:

> Werk met de bestaande checkout. Haal eerst de laatste versie van de repository op. Voer in de projectmap `python3 monitor.py scan --due` uit. Controleer de uitvoer en de wijzigingen in `data/state.json` en `dashboard.html`. Sla de resultaten duurzaam op in de repository zodat de volgende run de vorige metingen kan vergelijken. Meld websites die offline zijn, fouten geven of tegenstrijdige verzendinformatie tonen. Gebruik geen OpenAI API.

Codex-cloudtaken hebben niet vanzelf een permanente server of gedeelde schijf. De resultaten moeten na elke taak bewaard worden, bijvoorbeeld als commit in de repository. In deze sessie is geen functie beschikbaar om een terugkerende Codex-taak aan te maken. De webpagina moet apart gepubliceerd worden als je hem altijd online wilt bekijken, bijvoorbeeld via GitHub Pages.

## Grenzen van deze versie

- Publieke HTML is zichtbaar; winkelwagentjes, loginpagina's en JavaScript-inhoud die pas na laden verschijnt worden niet volledig gemeten.
- De prijscontrole gebruikt JSON-LD-productdata en zichtbare europrijzen. De verzendcontrole herkent eenvoudige Nederlandstalige en Engelstalige patronen en kan signalen missen of onterecht melden.
- `max_pages` begrenst een scan; daarmee is volledige dekking van een grote winkel niet gegarandeerd. Bij een scan staan het aantal bezochte pagina's en fouten in het overzicht.
- Uptime betekent dat de hoofdpagina tijdens de scan bereikbaar was; dit is geen continue monitoring.
