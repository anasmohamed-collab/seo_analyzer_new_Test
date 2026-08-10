import importlib.util
import pathlib
import sys
import types
import unittest
from unittest.mock import patch


if "flask" not in sys.modules:
    flask_stub = types.ModuleType("flask")

    class StubFlask:
        def __init__(self, *_args, **_kwargs):
            pass

        def route(self, *_args, **_kwargs):
            return lambda function: function

    flask_stub.Flask = StubFlask
    flask_stub.jsonify = lambda value: value
    flask_stub.request = types.SimpleNamespace()
    sys.modules["flask"] = flask_stub


APP_PATH = pathlib.Path(__file__).with_name("app.py")
SPEC = importlib.util.spec_from_file_location("scrapling_sidecar_app", APP_PATH)
sidecar = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(sidecar)


class OutboundUrlSafetyTests(unittest.TestCase):
    def test_multiword_ddos_vendor_is_precise_challenge_title(self):
        self.assertTrue(sidecar.is_challenge_page(
            "<title>DDoS Protection by Acme Security</title>",
        ))
        self.assertFalse(sidecar.is_challenge_page(
            "<title>Our Security Policy and Privacy Statement</title>",
        ))

    def test_public_a_and_aaaa_are_allowed(self):
        answers = [
            (2, 1, 6, "", ("93.184.216.34", 443)),
            (23, 1, 6, "", ("2606:2800:220:1:248:1893:25c8:1946", 443, 0, 0)),
        ]
        with patch.object(sidecar.socket, "getaddrinfo", return_value=answers):
            self.assertEqual(
                sidecar.validate_outbound_url("https://example.com/page"),
                "https://example.com/page",
            )

    def test_any_private_dns_answer_blocks_the_target(self):
        answers = [
            (2, 1, 6, "", ("93.184.216.34", 443)),
            (23, 1, 6, "", ("fd00::1", 443, 0, 0)),
        ]
        with patch.object(sidecar.socket, "getaddrinfo", return_value=answers):
            with self.assertRaises(sidecar.UnsafeOutboundUrl):
                sidecar.validate_outbound_url("https://mixed.example/page")

    def test_metadata_and_non_http_targets_are_blocked(self):
        for url in (
            "http://169.254.169.254/latest/meta-data",
            "http://metadata.google.internal/computeMetadata/v1/",
            "file:///etc/passwd",
        ):
            with self.subTest(url=url):
                with self.assertRaises(sidecar.UnsafeOutboundUrl):
                    sidecar.validate_outbound_url(url)

    def test_unsafe_reported_redirect_destination_is_rejected(self):
        class FakePage:
            text = "<html><body>content</body></html>"
            status = 200
            headers = {"content-type": "text/html"}
            url = "http://127.0.0.1/admin"

        class FakeFetcher:
            @staticmethod
            def get(**_kwargs):
                return FakePage()

        answers = [(2, 1, 6, "", ("93.184.216.34", 443))]
        with (
            patch.object(sidecar.socket, "getaddrinfo", return_value=answers),
            patch.object(sidecar, "_get_standard_fetcher", return_value=FakeFetcher),
        ):
            with self.assertRaises(sidecar.UnsafeOutboundUrl):
                sidecar._do_fetch("https://example.com/page", 10, None, False)


if __name__ == "__main__":
    unittest.main()
