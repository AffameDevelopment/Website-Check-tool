#!/usr/bin/env python3
"""Public storefront monitoring with a local, versionable JSON history."""

from __future__ import annotations

import argparse
import difflib
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from urllib.error import HTTPError, URLError
from urllib.parse import urldefrag, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen
from urllib.robotparser import RobotFileParser
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "sites.json"
STATE = ROOT / "data" / "state.json"
DASHBOARD = ROOT / "dashboard.html"
USER_AGENT = "WebsiteCheckTool/0.1 (public storefront monitor)"
TIMEOUT = 15
PRICE_RE = re.compile(r"(?:€\s*\d+(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?\s*€)")
SHIPPING_FEE_RE = re.compile(
    r"(?:verzendkosten|verzendtarief|shipping\s+(?:cost|fee))\s*[:]?\s*(?:vanaf\s*)?"
    r"(€\s*\d+(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?\s*€|gratis|free)", re.I
)
FREE_SHIPPING_RE = re.compile(r"(?:gratis\s+verzending|free\s+shipping)", re.I)
DELIVERY_RE = re.compile(
    r"(?:levertijd|bezorgtijd|delivery\s+time|ships?\s+in)\s*[:]?\s*"
    r"(\d+\s*(?:[-–]\s*\d+)?\s*(?:werkdagen|dagen|days|business\s+days))", re.I
)
SKIP_EXTENSIONS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".pdf", ".zip", ".css", ".js")


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def schedule_slot(site: dict, instant: datetime | None = None) -> str:
    """Identify the 09:00 or 21:00 local run, independent of small start delays."""
    local = (instant or datetime.now(timezone.utc)).astimezone(ZoneInfo(site.get("timezone", "Europe/Amsterdam")))
    day = local.date()
    frequency = int(site.get("frequency_per_day", 2))
    if frequency not in (1, 2):
        raise ValueError("frequency_per_day moet 1 of 2 zijn")
    if local.hour < 9:
        day -= timedelta(days=1)
        return f"{day}-evening" if frequency == 2 else str(day)
    if frequency == 1:
        return str(day)
    return f"{day}-evening" if local.hour >= 21 else f"{day}-morning"


def read_json(path: Path, default):
    if not path.exists():
        return default
    with path.open(encoding="utf-8") as file:
        return json.load(file)


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def normalize_url(url: str) -> str:
    url, _ = urldefrag(url)
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc or parts.username or parts.password:
        raise ValueError(f"Ongeldige publieke URL: {url}")
    path = parts.path or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, "", ""))


def in_scope(url: str, origin: str) -> bool:
    try:
        candidate = urlsplit(normalize_url(url))
    except ValueError:
        return False
    base = urlsplit(origin)
    return candidate.scheme == base.scheme and candidate.netloc == base.netloc and not candidate.path.lower().endswith(SKIP_EXTENSIONS)


def fetch(url: str, accept: str = "text/html") -> tuple[int, str, str]:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    try:
        with urlopen(request, timeout=TIMEOUT) as response:
            content_type = response.headers.get("Content-Type", "").split(";")[0].lower()
            body = response.read(2_000_001)
            if len(body) > 2_000_000:
                raise ValueError("Pagina groter dan 2 MB")
            encoding = response.headers.get_content_charset() or "utf-8"
            return response.status, content_type, body.decode(encoding, errors="replace")
    except HTTPError as error:
        return error.code, "", ""


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.text_parts: list[str] = []
        self.links: list[str] = []
        self.scripts: list[str] = []
        self._skip = 0
        self._title = False
        self._json_ld = False
        self.title_parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag in ("script", "style", "noscript", "svg"):
            self._skip += 1
            if tag == "script" and attributes.get("type", "").lower() == "application/ld+json":
                self._json_ld = True
        if tag == "title":
            self._title = True
        if tag == "a" and attributes.get("href"):
            self.links.append(attributes["href"])

    def handle_endtag(self, tag):
        if tag == "title":
            self._title = False
        if tag == "script":
            self._json_ld = False
        if tag in ("script", "style", "noscript", "svg"):
            self._skip = max(0, self._skip - 1)

    def handle_data(self, data):
        if self._json_ld:
            self.scripts.append(data)
        if self._title:
            self.title_parts.append(data)
        if not self._skip and data.strip():
            self.text_parts.append(data.strip())


def structured_prices(scripts: list[str]) -> list[str]:
    prices: set[str] = set()

    def walk(value):
        if isinstance(value, dict):
            if "price" in value and isinstance(value["price"], (str, int, float)):
                prices.add(str(value["price"]))
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    for script in scripts:
        try:
            walk(json.loads(script))
        except json.JSONDecodeError:
            pass
    return sorted(prices)


def parse_page(body: str, url: str) -> tuple[dict, list[str]]:
    parser = PageParser()
    parser.feed(body)
    visible = re.sub(r"\s+", " ", " ".join(parser.text_parts)).strip()
    prices = structured_prices(parser.scripts) or sorted(set(PRICE_RE.findall(visible)))[:30]
    fees = sorted(set(match.strip().lower() for match in SHIPPING_FEE_RE.findall(visible)))
    if FREE_SHIPPING_RE.search(visible):
        fees = sorted(set(fees + ["gratis"]))
    delivery = sorted(set(re.sub(r"\s+", " ", match.lower()).strip() for match in DELIVERY_RE.findall(visible)))
    shopify = bool(re.search(r"cdn\.shopify\.com|Shopify\.theme|shopify-section", body, re.I))
    wordpress = bool(re.search(r"wp-content|woocommerce", body, re.I))
    theme = re.search(r"/wp-content/themes/([^/\"'?]+)", body, re.I)
    if theme:
        theme_name = f"WordPress: {theme.group(1)}"
    elif shopify:
        theme_id = re.search(r"Shopify\.theme\s*=\s*\{[^}]*?\bid\s*:\s*(\d+)", body)
        theme_name = f"Shopify: {theme_id.group(1) if theme_id else 'gedetecteerd'}"
    else:
        theme_name = "onbekend"
    page = {
        "title": " ".join(parser.title_parts).strip(),
        "text": visible[:100_000],
        "text_hash": hashlib.sha256(visible.encode()).hexdigest(),
        "prices": prices,
        "shipping_fees": fees,
        "delivery_times": delivery,
        "theme": theme_name,
        "platform": "Shopify" if shopify else "WooCommerce/WordPress" if wordpress else "overig/onbekend",
    }
    links = []
    for href in parser.links:
        candidate = urljoin(url, href)
        if in_scope(candidate, url):
            links.append(normalize_url(candidate))
    return page, links


def robots_for(origin: str) -> tuple[RobotFileParser, list[str]]:
    parser = RobotFileParser()
    robots_url = origin.rstrip("/") + "/robots.txt"
    parser.set_url(robots_url)
    sitemaps = [origin.rstrip("/") + "/sitemap.xml"]
    try:
        status, _, body = fetch(robots_url, "text/plain")
        if status == 200:
            parser.parse(body.splitlines())
            sitemaps += [line.split(":", 1)[1].strip() for line in body.splitlines() if line.lower().startswith("sitemap:")]
        elif status in (401, 403):
            parser.disallow_all = True
        else:
            parser.parse([])
    except (URLError, TimeoutError, ValueError):
        parser.parse([])
    return parser, sitemaps


def sitemap_urls(origin: str, sitemap_list: list[str], maximum: int) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    queue = list(dict.fromkeys(sitemap_list))
    while queue and len(seen) < 30 and len(found) < maximum:
        url = queue.pop(0)
        if url in seen or not in_scope(url, origin):
            continue
        seen.add(url)
        try:
            status, _, body = fetch(url, "application/xml")
            if status != 200:
                continue
            root = ET.fromstring(body)
            locations = [node.text.strip() for node in root.iter() if node.tag.endswith("loc") and node.text]
            if root.tag.endswith("sitemapindex"):
                queue.extend(locations)
            else:
                found.extend(normalize_url(item) for item in locations if in_scope(item, origin))
        except (URLError, TimeoutError, ValueError, ET.ParseError):
            continue
    return list(dict.fromkeys(found))[:maximum]


def diff_events(old: dict, new: dict, url: str, timestamp: str) -> list[dict]:
    events = []
    for key, label in (("title", "Titel"), ("prices", "Prijzen"), ("shipping_fees", "Verzendkosten"),
                       ("delivery_times", "Levertijd"), ("theme", "Thema")):
        if old.get(key) != new.get(key):
            events.append({"at": timestamp, "url": url, "kind": label, "before": old.get(key), "after": new.get(key)})
    if old.get("text_hash") != new.get("text_hash"):
        changes = list(difflib.unified_diff(old.get("text", "").split(". "), new.get("text", "").split(". "), n=1))
        events.append({"at": timestamp, "url": url, "kind": "Tekst", "before": "", "after": "\n".join(changes)[:1200]})
    return events


def contradictions(pages: dict) -> list[dict]:
    result = []
    for field, label in (("shipping_fees", "Verzendkosten"), ("delivery_times", "Levertijd")):
        values: dict[str, list[str]] = {}
        for url, page in pages.items():
            for value in page.get(field, []):
                values.setdefault(value, []).append(url)
        if len(values) > 1:
            result.append({"kind": label, "values": values})
    return result


def scan(site: dict, previous: dict) -> dict:
    origin = normalize_url(site["url"])
    maximum = int(site.get("max_pages", 100))
    if maximum < 1 or maximum > 1000:
        raise ValueError("max_pages moet tussen 1 en 1000 liggen")
    interval = float(site.get("delay_seconds", 0.25))
    if interval < 0:
        raise ValueError("delay_seconds mag niet negatief zijn")
    timestamp = now()
    robots, sitemap_list = robots_for(origin)
    queue = [origin] + sitemap_urls(origin, sitemap_list, maximum)
    visited: set[str] = set()
    pages: dict[str, dict] = {}
    errors: list[dict] = []
    while queue and len(visited) < maximum:
        url = queue.pop(0)
        if url in visited or not in_scope(url, origin):
            continue
        visited.add(url)
        if not robots.can_fetch(USER_AGENT, url):
            errors.append({"url": url, "status": None, "message": "Niet gescand volgens robots.txt"})
            continue
        try:
            status, content_type, body = fetch(url)
            if status >= 400 or content_type not in ("text/html", "application/xhtml+xml"):
                errors.append({"url": url, "status": status, "message": "HTTP-fout" if status >= 400 else f"Geen HTML: {content_type}"})
                continue
            page, links = parse_page(body, url)
            page["status"] = status
            pages[url] = page
            queue.extend(link for link in links if link not in visited)
        except (URLError, TimeoutError, ValueError, UnicodeError) as error:
            errors.append({"url": url, "status": None, "message": str(error)[:200]})
        if interval:
            time.sleep(interval)
    old_pages = previous.get("pages", {})
    root_error = next((item for item in errors if item["url"] == origin), None)
    unmeasured = bool(root_error and root_error["status"] is None)
    if unmeasured:
        # Retain the previous successful snapshot. A failed request is not a page deletion.
        pages = old_pages
    events = previous.get("events", []).copy()
    if previous.get("last_scan") and not unmeasured:
        for url, page in pages.items():
            if url in old_pages:
                events.extend(diff_events(old_pages[url], page, url, timestamp))
            else:
                events.append({"at": timestamp, "url": url, "kind": "Nieuwe pagina", "before": "", "after": page["title"]})
        for url in old_pages.keys() - pages.keys():
            if not any(error["url"] == url for error in errors):
                events.append({"at": timestamp, "url": url, "kind": "Pagina verdwenen", "before": old_pages[url].get("title"), "after": ""})
    # A blocked network or DNS failure does not prove that the storefront is down.
    up = None if unmeasured else origin in pages
    history = previous.get("history", []).copy()
    history.append({"at": timestamp, "up": up, "page_count": 0 if unmeasured else len(pages), "error_count": len(errors)})
    return {
        "name": site.get("name") or urlsplit(origin).netloc,
        "url": origin,
        "frequency_per_day": site.get("frequency_per_day", 2),
        "last_slot": schedule_slot(site),
        "last_scan": timestamp,
        "up": up,
        "root_error": root_error,
        "pages": pages,
        "errors": errors,
        "contradictions": contradictions(pages),
        "events": events[-1000:],
        "history": history[-365:],
    }


def render(state: dict) -> None:
    escape = lambda value: html.escape(str(value), quote=True)
    sections = []
    for site in state.get("sites", {}).values():
        status = "Online" if site.get("up") is True else "Offline / HTTP-fout" if site.get("up") is False else "Niet gemeten"
        summary = f"{len(site.get('pages', {}))} pagina's · {len(site.get('errors', []))} fouten · laatste scan {site.get('last_scan', 'nooit')} UTC"
        issues = "".join(
            f"<li><strong>{escape(item['kind'])}</strong>: " + "; ".join(
                f"{escape(value)} op {', '.join(escape(url) for url in urls[:5])}" for value, urls in item["values"].items()
            ) + "</li>" for item in site.get("contradictions", [])
        ) or "<li>Geen tegenstrijdige verzendwaarden gevonden.</li>"
        errors = "".join(f"<li>{escape(item['url'])}: {escape(item['message'])} {escape(item.get('status') or '')}</li>" for item in site.get("errors", [])) or "<li>Geen fouten.</li>"
        events = "".join(
            f"<li><time>{escape(item['at'])}</time> <strong>{escape(item['kind'])}</strong> "
            f"<a href='{escape(item['url'])}'>{escape(item['url'])}</a>"
            f"<details><summary>Verschil</summary><pre>{escape(item.get('before'))}\n→\n{escape(item.get('after'))}</pre></details></li>"
            for item in reversed(site.get("events", [])[-50:])
        ) or "<li>Alleen een nulmeting beschikbaar; nog geen wijzigingen.</li>"
        sections.append(
            f"<section><h2>{escape(site['name'])} <small class={'ok' if site.get('up') is True else 'bad'}>{status}</small></h2>"
            f"<p><a href='{escape(site['url'])}'>{escape(site['url'])}</a> · {escape(summary)}</p>"
            f"<h3>Mogelijke tegenstrijdigheden</h3><ul>{issues}</ul><h3>Fouten</h3><ul>{errors}</ul>"
            f"<h3>Recente wijzigingen</h3><ul>{events}</ul></section>"
        )
    DASHBOARD.write_text(
        "<!doctype html><html lang='nl'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>Website Check</title><style>body{font:16px system-ui;margin:2rem auto;max-width:1100px;padding:0 1rem;color:#162334;background:#f5f7fa}"
        "section{background:white;padding:1.5rem;margin:1rem 0;border-radius:12px;box-shadow:0 2px 8px #dce2e9}"
        "li{margin:.6rem 0;overflow-wrap:anywhere}.ok{color:#087443}.bad{color:#b11d25}small{font-size:.65em}"
        "pre{white-space:pre-wrap;background:#f3f5f7;padding:1rem}a{color:#1455a3}</style>"
        "<h1>Website Check</h1><p>Publieke webshopcontroles. Alle tijden zijn UTC. Verzendverschillen zijn signalen om handmatig te beoordelen.</p>"
        + ("".join(sections) if sections else "<p>Er zijn nog geen websites toegevoegd. Gebruik <code>python3 monitor.py add URL</code>.</p>")
        + "</html>\n", encoding="utf-8"
    )


def main() -> int:
    argument = argparse.ArgumentParser(description="Controleer publieke webshops zonder betaalde API")
    commands = argument.add_subparsers(dest="command", required=True)
    add = commands.add_parser("add", help="Voeg een webshop toe")
    add.add_argument("url")
    add.add_argument("--name")
    add.add_argument("--frequency", type=int, choices=(1, 2), default=2)
    add.add_argument("--max-pages", type=int, default=100)
    run = commands.add_parser("scan", help="Scan alle of één webshop")
    run.add_argument("--due", action="store_true", help="Sla winkels over die nog niet aan de beurt zijn")
    run.add_argument("--site", help="URL van één winkel")
    commands.add_parser("render", help="Bouw het dashboard opnieuw op")
    commands.add_parser("list", help="Toon ingestelde websites")
    args = argument.parse_args()
    config = read_json(CONFIG, {"sites": []})
    state = read_json(STATE, {"sites": {}})
    if args.command == "add":
        url = normalize_url(args.url)
        if any(normalize_url(item["url"]) == url for item in config["sites"]):
            argument.error("Deze website staat al in sites.json")
        config["sites"].append({"url": url, "name": args.name or urlsplit(url).netloc,
                                "frequency_per_day": args.frequency, "timezone": "Europe/Amsterdam",
                                "max_pages": args.max_pages, "delay_seconds": 0.25})
        write_json(CONFIG, config)
        print(f"Toegevoegd: {url}")
    elif args.command == "list":
        for item in config["sites"]:
            print(f"{item['url']} ({item.get('frequency_per_day', 2)}x per dag)")
    elif args.command == "scan":
        for site in config["sites"]:
            url = normalize_url(site["url"])
            if args.site and normalize_url(args.site) != url:
                continue
            previous = state["sites"].get(url, {})
            if args.due and previous.get("last_slot") == schedule_slot(site) and previous.get("up") is not None:
                print(f"Nog niet aan de beurt: {url}")
                continue
            print(f"Scan: {url}", flush=True)
            state["sites"][url] = scan(site, previous)
            write_json(STATE, state)
            result = state["sites"][url]
            health = "Online" if result["up"] is True else "Offline" if result["up"] is False else "Niet gemeten"
            print(f"{health}; {len(result['pages'])} pagina's; "
                  f"{len(result['errors'])} fouten; {len(result['contradictions'])} mogelijke tegenstrijdigheden")
        render(state)
    elif args.command == "render":
        render(state)
        print(DASHBOARD)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(f"Fout: {error}", file=sys.stderr)
        sys.exit(1)
