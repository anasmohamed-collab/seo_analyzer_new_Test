"""Scrapling sidecar – thin HTTP wrapper around Scrapling's Fetcher."""

import os
import time
import traceback

from flask import Flask, jsonify, request

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Lazy-import Scrapling so the module loads even if scrapling isn't installed
# (useful for running tests against the Flask app itself).
# ---------------------------------------------------------------------------
_fetcher = None


def _get_fetcher():
    global _fetcher
    if _fetcher is None:
        from scrapling.fetchers import Fetcher  # noqa: WPS433
        _fetcher = Fetcher
    return _fetcher


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


# ---------------------------------------------------------------------------
# POST /fetch  –  fetch a single URL and return HTML + metadata
#
# Request body (JSON):
#   url        (required)  – the URL to fetch
#   timeout    (optional)  – seconds, default 20
#   user_agent (optional)  – override UA string
#   headless   (optional)  – if true, use StealthyFetcher (browser mode)
#
# Response (JSON):
#   html       – full page HTML
#   status     – HTTP status code
#   headers    – dict of response headers
#   url        – final URL after redirects
#   elapsed_ms – fetch duration in milliseconds
# ---------------------------------------------------------------------------
@app.route("/fetch", methods=["POST"])
def fetch_url():
    body = request.get_json(force=True, silent=True) or {}
    url = (body.get("url") or "").strip()

    if not url:
        return jsonify({"error": "url is required"}), 400

    timeout = min(int(body.get("timeout", 20)), 60)
    user_agent = body.get("user_agent")
    headless = body.get("headless", False)

    start = time.time()

    try:
        if headless:
            from scrapling.fetchers import StealthyFetcher  # noqa: WPS433
            fetcher = StealthyFetcher
        else:
            fetcher = _get_fetcher()

        kwargs = {"url": url, "timeout": timeout}
        if user_agent:
            kwargs["headers"] = {"User-Agent": user_agent}

        page = fetcher.get(**kwargs)

        elapsed_ms = round((time.time() - start) * 1000)

        return jsonify({
            "html": page.text if hasattr(page, "text") else str(page),
            "status": page.status if hasattr(page, "status") else 200,
            "headers": dict(page.headers) if hasattr(page, "headers") else {},
            "url": str(page.url) if hasattr(page, "url") else url,
            "elapsed_ms": elapsed_ms,
        })

    except Exception as exc:
        elapsed_ms = round((time.time() - start) * 1000)
        return jsonify({
            "error": str(exc),
            "traceback": traceback.format_exc(),
            "elapsed_ms": elapsed_ms,
        }), 502


# ---------------------------------------------------------------------------
# POST /fetch-batch  –  fetch multiple URLs concurrently
#
# Request body (JSON):
#   urls       (required)  – list of URL strings (max 20)
#   timeout    (optional)  – per-URL timeout, default 20
#   user_agent (optional)
#
# Response (JSON):
#   results    – list of {url, html, status, headers, elapsed_ms} | {url, error}
# ---------------------------------------------------------------------------
@app.route("/fetch-batch", methods=["POST"])
def fetch_batch():
    body = request.get_json(force=True, silent=True) or {}
    urls = body.get("urls", [])

    if not urls or not isinstance(urls, list):
        return jsonify({"error": "urls (list) is required"}), 400

    urls = urls[:20]  # cap at 20
    timeout = min(int(body.get("timeout", 20)), 60)
    user_agent = body.get("user_agent")
    fetcher = _get_fetcher()

    results = []
    for url in urls:
        start = time.time()
        try:
            kwargs = {"url": url, "timeout": timeout}
            if user_agent:
                kwargs["headers"] = {"User-Agent": user_agent}
            page = fetcher.get(**kwargs)
            elapsed_ms = round((time.time() - start) * 1000)
            results.append({
                "url": str(page.url) if hasattr(page, "url") else url,
                "html": page.text if hasattr(page, "text") else str(page),
                "status": page.status if hasattr(page, "status") else 200,
                "headers": dict(page.headers) if hasattr(page, "headers") else {},
                "elapsed_ms": elapsed_ms,
            })
        except Exception as exc:
            elapsed_ms = round((time.time() - start) * 1000)
            results.append({
                "url": url,
                "error": str(exc),
                "elapsed_ms": elapsed_ms,
            })

    return jsonify({"results": results})


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("SIDECAR_PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
