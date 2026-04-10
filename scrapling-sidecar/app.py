"""
Scrapling sidecar — two-tier fetch with optional stealth (headless) bypass.

Tiers
-----
1. Fetcher (standard)
   Fast HTTP with TLS/header fingerprint rotation.  Handles most non-WAF sites
   and sites that whitelist common browser UAs.

2. StealthyFetcher (stealth)
   Full headless browser (Camoufox / Firefox-based).  Slower, but can execute
   challenge JavaScript and often bypass Cloudflare IUAM, DataDome, etc.

Mode request parameter
----------------------
  "auto"     (default) — try Tier 1; if a challenge page is detected, escalate
                         to Tier 2 automatically.
  "standard" — Tier 1 only (fast path, for non-WAF scenarios).
  "stealth"  — Tier 2 only (caller already knows a challenge is present).

Response shape
--------------
  html              – page body (HTML or XML)
  status            – HTTP status code (int)
  headers           – dict of response headers
  url               – final URL after redirects
  elapsed_ms        – total wall-clock time (ms)
  challenge_detected – bool: does the returned body look like a WAF challenge?
  bypassed           – bool: was a challenge present initially but bypassed by stealth?
  mode_used          – "standard" | "stealth"

Environment variables
---------------------
  MAX_STEALTH_CONCURRENT – max parallel stealth sessions (default: 2)
  SIDECAR_PORT           – HTTP port (default: 5000)
"""

import os
import re
import time
import logging
import threading
import traceback

from flask import Flask, jsonify, request

app = Flask(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("scrapling-sidecar")

# ── Stealth concurrency limiter ──────────────────────────────────────────────
# Headless browsers consume ~300-500 MB RAM each; limit parallel instances.
_MAX_STEALTH = int(os.environ.get("MAX_STEALTH_CONCURRENT", "2"))
_stealth_semaphore = threading.Semaphore(_MAX_STEALTH)

# ── Challenge-page patterns (mirrors Node.js isBotProtectionPage) ───────────
# Keep in sync with backend/src/services/fetch/fetchEngine.ts.
_CHALLENGE_PATTERNS: list[re.Pattern] = [
    # Cloudflare
    re.compile(r"window\._cf_chl_opt\b"),
    re.compile(r"<title>\s*Just a moment\.\.\.\s*</title>", re.I),
    re.compile(r"/cdn-cgi/challenge-platform/"),
    re.compile(r'id="cf-browser-verification"'),
    re.compile(r'class="cf-turnstile"'),
    re.compile(r"<title>\s*Attention Required!\s*</title>", re.I),
    # Imperva / Incapsula
    re.compile(r"<!-- Incapsula incident ID:"),
    # DataDome
    re.compile(r"tag\.captcha-delivery\.com"),
    re.compile(r"window\.ddjskey\s*="),
    # PerimeterX / HUMAN
    re.compile(r"_pxAppId\s*="),
    re.compile(r'px-captcha|class="pxCaptcha"'),
    # AWS WAF
    re.compile(r"aws-waf-token"),
]

_TITLE_RE = re.compile(r"<title[^>]*>([\s\S]{0,300}?)</title>", re.I)
_CHALLENGE_TITLES_RE = re.compile(
    r"^("
    r"verify you are human"
    r"|human verification"
    r"|bot check"
    r"|ddos protection(?: by \w+)?"
    r"|please verify you are(?: a)? human"
    r"|you have been blocked"
    r"|browser integrity check"
    r"|security check required"
    r"|checking your browser\.\.\."
    r"|please wait\.\.\."
    r"|one more step"
    r")$",
    re.I,
)


def is_challenge_page(html: str) -> bool:
    """Return True when *html* appears to be a WAF challenge / CAPTCHA gate."""
    if not html or len(html) < 10:
        return False
    for pat in _CHALLENGE_PATTERNS:
        if pat.search(html):
            return True
    m = _TITLE_RE.search(html[:6000])
    if m and _CHALLENGE_TITLES_RE.match(m.group(1).strip()):
        return True
    return False


# ── Fetcher availability ──────────────────────────────────────────────────────

def _get_standard_fetcher():
    from scrapling.fetchers import Fetcher  # type: ignore[import]
    return Fetcher


def _get_stealth_fetcher():
    from scrapling.fetchers import StealthyFetcher  # type: ignore[import]
    return StealthyFetcher


_stealth_ok: bool | None = None  # cached after first probe


def stealth_available() -> bool:
    global _stealth_ok
    if _stealth_ok is None:
        try:
            _get_stealth_fetcher()
            _stealth_ok = True
        except Exception:
            _stealth_ok = False
    return _stealth_ok


# ── Core fetch ────────────────────────────────────────────────────────────────

def _do_fetch(
    url: str,
    timeout: int,
    user_agent: str | None,
    use_stealth: bool,
) -> dict:
    """
    Perform one fetch attempt.  Raises on network/browser failure.
    Returns a plain dict with html, status, headers, url, elapsed_ms.
    """
    start = time.time()

    if use_stealth:
        fetcher_cls = _get_stealth_fetcher()
        kwargs: dict = {"url": url, "timeout": timeout}
    else:
        fetcher_cls = _get_standard_fetcher()
        kwargs = {"url": url, "timeout": timeout}
        if user_agent:
            kwargs["headers"] = {"User-Agent": user_agent}

    page = fetcher_cls.get(**kwargs)

    html = page.text if hasattr(page, "text") else str(page)
    status = int(page.status) if hasattr(page, "status") else 200
    headers = dict(page.headers) if hasattr(page, "headers") else {}
    final_url = str(page.url) if hasattr(page, "url") else url
    elapsed_ms = round((time.time() - start) * 1000)

    return {
        "html": html,
        "status": status,
        "headers": headers,
        "url": final_url,
        "elapsed_ms": elapsed_ms,
    }


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "stealth_available": stealth_available(),
        "max_stealth_concurrent": _MAX_STEALTH,
    })


@app.route("/fetch", methods=["POST"])
def fetch_url():
    body = request.get_json(force=True, silent=True) or {}
    url = (body.get("url") or "").strip()
    if not url:
        return jsonify({"error": "url is required"}), 400

    timeout = min(max(int(body.get("timeout", 25)), 1), 60)
    user_agent: str | None = body.get("user_agent")
    mode = (body.get("mode") or "auto").lower()

    overall_start = time.time()

    try:
        if mode == "stealth":
            return _handle_stealth_only(url, timeout, user_agent, overall_start)
        elif mode == "standard":
            return _handle_standard_only(url, timeout, user_agent)
        else:
            return _handle_auto(url, timeout, user_agent, overall_start)

    except Exception as exc:
        logger.exception("Unhandled error for %s", url)
        return jsonify({
            "error": str(exc),
            "traceback": traceback.format_exc(),
            "elapsed_ms": round((time.time() - overall_start) * 1000),
        }), 502


def _handle_standard_only(url: str, timeout: int, user_agent: str | None):
    logger.info("[standard] %s", url)
    result = _do_fetch(url, timeout, user_agent, use_stealth=False)
    challenge = is_challenge_page(result["html"])
    result.update(challenge_detected=challenge, bypassed=False, mode_used="standard")
    return jsonify(result)


def _handle_stealth_only(
    url: str, timeout: int, user_agent: str | None, overall_start: float
):
    if not stealth_available():
        return jsonify({"error": "StealthyFetcher not available (Camoufox not installed)"}), 503
    logger.info("[stealth] %s", url)
    with _stealth_semaphore:
        result = _do_fetch(url, timeout, user_agent, use_stealth=True)
    challenge = is_challenge_page(result["html"])
    result.update(
        challenge_detected=challenge,
        bypassed=not challenge,  # by definition: we used stealth, so challenge→bypassed
        mode_used="stealth",
        elapsed_ms=round((time.time() - overall_start) * 1000),
    )
    return jsonify(result)


def _handle_auto(
    url: str, timeout: int, user_agent: str | None, overall_start: float
):
    """
    Auto mode:
      1. Try standard Fetcher.
      2. If challenge detected (or standard failed) → try StealthyFetcher.
      3. Return the best result with accurate bypassed/challenge_detected flags.
    """
    logger.info("[auto] %s — standard first", url)

    standard_result: dict | None = None
    standard_error: str | None = None

    try:
        standard_result = _do_fetch(url, timeout, user_agent, use_stealth=False)
    except Exception as exc:
        standard_error = str(exc)
        logger.warning("[auto] Standard failed: %s — will try stealth", exc)

    standard_challenge = (
        is_challenge_page(standard_result["html"]) if standard_result else True
    )

    if not standard_challenge and standard_result:
        # Standard path succeeded with real content — fast return.
        standard_result.update(
            challenge_detected=False, bypassed=False, mode_used="standard"
        )
        return jsonify(standard_result)

    # ── Challenge or failure detected — escalate to stealth ──────────────────
    if not stealth_available():
        logger.warning("[auto] Challenge detected but StealthyFetcher unavailable for %s", url)
        if standard_result:
            standard_result.update(
                challenge_detected=True,
                bypassed=False,
                mode_used="standard",
                stealth_unavailable=True,
            )
            return jsonify(standard_result)
        return jsonify({
            "error": f"Standard fetch failed and StealthyFetcher not available: {standard_error}",
            "elapsed_ms": round((time.time() - overall_start) * 1000),
        }), 502

    logger.info("[auto] Challenge → escalating to stealth for %s", url)
    try:
        with _stealth_semaphore:
            stealth_result = _do_fetch(url, timeout, user_agent, use_stealth=True)
    except Exception as stealth_exc:
        logger.error("[auto] Stealth also failed for %s: %s", url, stealth_exc)
        if standard_result:
            standard_result.update(
                challenge_detected=True,
                bypassed=False,
                mode_used="standard",
                stealth_error=str(stealth_exc),
            )
            return jsonify(standard_result)
        return jsonify({
            "error": f"Both standard and stealth failed: {stealth_exc}",
            "elapsed_ms": round((time.time() - overall_start) * 1000),
        }), 502

    stealth_challenge = is_challenge_page(stealth_result["html"])
    # bypassed=True means: challenge WAS present (standard returned one) but stealth got past it
    stealth_result.update(
        challenge_detected=stealth_challenge,
        bypassed=(not stealth_challenge),
        mode_used="stealth",
        elapsed_ms=round((time.time() - overall_start) * 1000),
    )
    return jsonify(stealth_result)


@app.route("/fetch-batch", methods=["POST"])
def fetch_batch():
    """
    Standard-mode batch fetch (no stealth — use /fetch individually for WAF bypass).
    Limited to 20 URLs.
    """
    body = request.get_json(force=True, silent=True) or {}
    urls = body.get("urls", [])
    if not urls or not isinstance(urls, list):
        return jsonify({"error": "urls (list) is required"}), 400

    urls = urls[:20]
    timeout = min(int(body.get("timeout", 20)), 60)
    user_agent: str | None = body.get("user_agent")

    results = []
    for url in urls:
        start = time.time()
        try:
            res = _do_fetch(url, timeout, user_agent, use_stealth=False)
            res.update(challenge_detected=is_challenge_page(res["html"]), mode_used="standard")
            results.append(res)
        except Exception as exc:
            results.append({
                "url": url,
                "error": str(exc),
                "elapsed_ms": round((time.time() - start) * 1000),
            })

    return jsonify({"results": results})


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("SIDECAR_PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
