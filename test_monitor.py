import unittest
from unittest.mock import patch
from urllib.error import URLError
from datetime import datetime, timezone

import monitor


class AllowRobots:
    def can_fetch(self, _agent, _url):
        return True


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.site = {"url": "https://store.example/", "name": "Testwinkel", "max_pages": 10, "delay_seconds": 0}

    def test_two_scans_detect_changes_and_conflicting_shipping(self):
        pages = {
            "https://store.example/": '<html><title>Winkel</title><body><a href="/shipping">Verzending</a>'
                                      'Verzendkosten: €4,95 Levertijd: 1-2 werkdagen</body></html>',
            "https://store.example/shipping": '<html><title>Verzending</title><body>'
                                             'Verzendkosten: €5,95 Levertijd: 3-4 werkdagen</body></html>',
        }

        def fake_fetch(url, _accept="text/html"):
            return 200, "text/html", pages[url]

        with patch.object(monitor, "robots_for", return_value=(AllowRobots(), [])), \
             patch.object(monitor, "sitemap_urls", return_value=[]), \
             patch.object(monitor, "fetch", side_effect=fake_fetch):
            first = monitor.scan(self.site, {})
            self.assertTrue(first["up"])
            self.assertEqual(2, len(first["pages"]))
            self.assertEqual(2, len(first["contradictions"]))
            self.assertEqual([], first["events"])
            pages["https://store.example/shipping"] = pages["https://store.example/shipping"].replace("€5,95", "€6,95")
            second = monitor.scan(self.site, first)
        self.assertTrue(any(item["kind"] == "Verzendkosten" for item in second["events"]))
        self.assertTrue(any(item["kind"] == "Tekst" for item in second["events"]))

    def test_network_failure_does_not_report_store_as_offline_or_delete_pages(self):
        previous = {"last_scan": monitor.now(), "pages": {"https://store.example/": {"title": "Winkel"}},
                    "events": [], "history": []}
        with patch.object(monitor, "robots_for", return_value=(AllowRobots(), [])), \
             patch.object(monitor, "sitemap_urls", return_value=[]), \
             patch.object(monitor, "fetch", side_effect=URLError("network blocked")):
            result = monitor.scan(self.site, previous)
        self.assertIsNone(result["up"])
        self.assertEqual(previous["pages"], result["pages"])
        self.assertEqual([], result["events"])

    def test_storefront_platform_theme_and_structured_price(self):
        shopify = ('<html><title>Product</title><body><script type="application/ld+json">'
                   '{"@type":"Product","offers":{"price":"29.95"}}</script>'
                   '<img src="https://cdn.shopify.com/example.png"> Product</body></html>')
        parsed, _ = monitor.parse_page(shopify, "https://store.example/product")
        self.assertEqual("Shopify", parsed["platform"])
        self.assertEqual(["29.95"], parsed["prices"])
        wordpress = '<html><link href="/wp-content/themes/storefront/style.css"><body>Hallo</body></html>'
        parsed, _ = monitor.parse_page(wordpress, "https://store.example/")
        self.assertEqual("WooCommerce/WordPress", parsed["platform"])
        self.assertEqual("WordPress: storefront", parsed["theme"])

    def test_daily_slots_allow_morning_and_evening_scans(self):
        site = {"timezone": "Europe/Amsterdam", "frequency_per_day": 2}
        morning = datetime(2026, 10, 9, 7, 5, tzinfo=timezone.utc)
        evening = datetime(2026, 10, 9, 19, 0, tzinfo=timezone.utc)
        self.assertEqual("2026-10-09-morning", monitor.schedule_slot(site, morning))
        self.assertEqual("2026-10-09-evening", monitor.schedule_slot(site, evening))


if __name__ == "__main__":
    unittest.main()
