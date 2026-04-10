FROM python:3.12-slim

WORKDIR /app

# ── System dependencies ──────────────────────────────────────────────────────
# libxml2 / libxslt  — for scrapling's lxml HTML parser
# The block below installs the minimal shared libraries required by
# Camoufox (Firefox-based headless browser used by StealthyFetcher).
# These are the same libraries used by Firefox on Debian/Ubuntu.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        gcc \
        libxml2-dev \
        libxslt1-dev \
        # Camoufox / Firefox runtime deps
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libglib2.0-0 \
        libnss3 \
        libnspr4 \
        libpango-1.0-0 \
        libxcomposite1 \
        libxdamage1 \
        libxkbcommon0 \
        libxrandr2 && \
    rm -rf /var/lib/apt/lists/*

# ── Python dependencies ───────────────────────────────────────────────────────
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Download Camoufox browser binary ─────────────────────────────────────────
# This bakes the browser into the image so StealthyFetcher is available at
# runtime without an outbound download.  The step is best-effort: if the
# download fails (e.g. network restricted build env), the sidecar still works
# in standard mode and `stealth_available` returns false in /health.
RUN python -m camoufox fetch || echo "[WARNING] Camoufox browser download failed — stealth mode will be unavailable"

# ── Application ───────────────────────────────────────────────────────────────
COPY app.py .

EXPOSE 5000

# Single gunicorn worker: headless browsers are memory-intensive (~400 MB each).
# Concurrent stealth sessions are rate-limited by MAX_STEALTH_CONCURRENT (default 2)
# inside the app, so one process is sufficient for the sidecar role.
CMD ["gunicorn", \
     "--bind", "0.0.0.0:5000", \
     "--workers", "1", \
     "--timeout", "120", \
     "--keep-alive", "5", \
     "app:app"]
