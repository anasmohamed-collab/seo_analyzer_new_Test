import process from 'node:process';
import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first'); // prevent ENETUNREACH on IPv6-disabled container networks
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync as _readFileSync } from 'node:fs';
import { seoIntelligenceRouter } from './routes/seo-intelligence.js';
import { seoCrawlerRouter } from './routes/seo-site-crawler.js';
import { newsSeoRouter } from './routes/news-seo.js';
import { unifiedAuditRouter } from './routes/unified-audit.js';
import { GIT_SHA_ENV_VARS, resolveGitSha } from '../shared/git-sha.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --------------- Load .env file if present (fallback for platforms that don't inject env vars) ---------------
try {
  const envPath = join(__dirname, '..', '.env');
  const envContent = _readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && val && !process.env[key]) {
      process.env[key] = val;
    }
  }
  console.log('[env] Loaded variables from .env file');
} catch {
  // No .env file — rely on platform-injected environment variables (normal in production)
}

// --------------- Debug: log which DB-related env vars are present ---------------
const _dbVars = Object.keys(process.env).filter(k =>
  k.includes('DATABASE') || k.includes('POSTGRES') || k.includes('PG_')
);
console.log('[env] DB-related env vars present:', _dbVars.length > 0 ? _dbVars.join(', ') : 'none');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// --------------- Database config validation ---------------
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn('⚠  DATABASE WARNING: DATABASE_URL is not set.');
  console.warn('   The server will run in IN-MEMORY mode — audit results will not be persisted.');
  console.warn('   Set DATABASE_URL=postgresql://user:password@host:5432/dbname to enable persistence.');
} else {
  // Show host only — never log credentials
  try {
    const u = new URL(DATABASE_URL);
    console.log(`✓  PostgreSQL configured: ${u.hostname}:${u.port || 5432}${u.pathname}`);
  } catch {
    console.log('✓  PostgreSQL DATABASE_URL configured');
  }
}

// --------------- Middleware ---------------
app.use((req, _res, next) => {
  if (req.url.startsWith('/api')) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  }
  next();
});
app.use(express.json({ limit: '2mb' }));

// CORS - allow all origins (same behaviour as the edge functions)
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Info, Apikey');
  if (_req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --------------- Health check ---------------
app.get('/health', async (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// --------------- API routes ---------------

// Readiness probe: is the DB reachable and is the schema actually usable?
// Result is cached for 30s so the public endpoint never hammers the pool.
// `to_regclass` is a catalog lookup — no table scan, safe on every check.
const DB_READY_CACHE_MS = 30_000;
let _dbReadyCache = { at: 0, connected: false, schemaReady: false };
let _getDbFn = null;

async function checkDbReadiness() {
  if (!process.env.DATABASE_URL) {
    return { configured: false, connected: false, schemaReady: false };
  }
  const now = Date.now();
  if (now - _dbReadyCache.at < DB_READY_CACHE_MS) {
    return { configured: true, connected: _dbReadyCache.connected, schemaReady: _dbReadyCache.schemaReady };
  }
  let connected = false;
  let schemaReady = false;
  try {
    if (!_getDbFn) {
      ({ getDb: _getDbFn } = await import('../backend/dist/lib/db.js'));
    }
    const db = _getDbFn();
    if (db) {
      const r = await db.query("SELECT to_regclass('public.sites') IS NOT NULL AS ready");
      connected = true;
      schemaReady = r.rows[0]?.ready === true;
    }
  } catch (err) {
    console.error('[health] DB readiness check failed:', err.message);
  }
  _dbReadyCache = { at: now, connected, schemaReady };
  return { configured: true, connected, schemaReady };
}

app.get('/api/health', async (_req, res) => {
  const dbUrl = process.env.DATABASE_URL;
  let dbHost = null;
  if (dbUrl) {
    try { dbHost = new URL(dbUrl).hostname; } catch { dbHost = 'configured'; }
  }

  const db = await checkDbReadiness();
  // Not configured = intentional in-memory mode → still healthy.
  // Configured but unreachable/schema missing = not ready → 503.
  const ready = !db.configured || (db.connected && db.schemaReady);

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    database: {
      configured: db.configured,
      connected: db.connected,
      schemaReady: db.schemaReady,
      host: dbHost,
    },
    env: {
      DB_CONFIGURED: !!dbUrl,
      DB_HOST: dbHost,
      SCRAPLING_SIDECAR_URL: process.env.SCRAPLING_SIDECAR_URL || null,
      NODE_ENV: process.env.NODE_ENV || 'not set',
      PORT: process.env.PORT || 'not set',
    },
  });
});

app.use('/api/seo-intelligence', seoIntelligenceRouter);
app.use('/api/seo-site-crawler', seoCrawlerRouter);
app.use('/api/news-seo', newsSeoRouter);
app.use('/api/unified-audit', unifiedAuditRouter);

// Auto-run database migrations on startup when DATABASE_URL is configured.
// The migration script is idempotent — already-applied migrations are skipped.
// This runs synchronously so the server is ready only after the DB is set up.
import { existsSync as _existsSync } from 'node:fs';
import { execSync as _execSync } from 'node:child_process';

if (DATABASE_URL) {
  console.log('Running database migrations…');
  try {
    _execSync('node scripts/migrate.js', { cwd: join(__dirname, '..'), stdio: 'inherit' });
    console.log('Migrations complete.');
  } catch (migrateErr) {
    // A server that accepts traffic without its schema returns 500 on every
    // DB endpoint and hides the real problem. Fail loudly instead — the
    // platform restarts the container and each attempt logs the same clear
    // error until the database or DATABASE_URL is fixed.
    console.error('FATAL: database migrations failed:', migrateErr.message);
    console.error('Refusing to start with an unusable schema. Fix DATABASE_URL or the database and redeploy.');
    process.exit(1);
  }
}

// Phase 1: DB-backed audit routes (loaded from compiled backend)
// Auto-compile if dist is missing so the server works out-of-the-box.

const backendDistEntry = join(__dirname, '..', 'backend', 'dist', 'routes', 'auditRunsSimple.js');
if (!_existsSync(backendDistEntry)) {
  console.log('backend/dist not found — compiling TypeScript now (this only runs once)…');
  try {
    _execSync('npm run build:backend', { cwd: join(__dirname, '..'), stdio: 'inherit' });
    console.log('Backend compiled successfully.');
  } catch (buildErr) {
    console.error('Backend compilation failed:', buildErr.message);
  }
}

try {
  const { auditRunsRouter } = await import('../backend/dist/routes/auditRunsSimple.js');
  app.use('/api', auditRunsRouter);
  console.log('Phase 1 audit routes loaded');
} catch (err) {
  console.error('Phase 1 audit routes FAILED to load:', err.message);
  // Register a clear 503 for the affected endpoints so the UI shows a useful error.
  app.post('/api/technical-analyzer/run', (_req, res) => {
    res.status(503).json({ error: 'Audit service unavailable — backend compilation failed. Check server logs.' });
  });
}

// Project management & audit history routes
try {
  const { projectsRouter } = await import('../backend/dist/routes/projects.js');
  app.use('/api', projectsRouter);
  console.log('Project management routes loaded');
} catch (err) {
  console.warn('Project management routes not available:', err.message);
}

// News Sitemap audit route (isolated, additive — stateless, no DB required)
try {
  const { newsSitemapAuditRouter } = await import('../backend/dist/routes/newsSitemapAudit.js');
  app.use('/api', newsSitemapAuditRouter);
  console.log('News Sitemap audit route loaded');
} catch (err) {
  console.warn('News Sitemap audit route not available:', err.message);
}

// Robots.txt audit route (isolated, additive — stateless, no DB required)
try {
  const { robotsTxtAuditRouter } = await import('../backend/dist/routes/robotsTxtAudit.js');
  app.use('/api', robotsTxtAuditRouter);
  console.log('Robots.txt audit route loaded');
} catch (err) {
  console.warn('Robots.txt audit route not available:', err.message);
}

// AI Assist route (isolated, additive — server-side NVIDIA NIM calls).
// Optional: if NVIDIA_API_KEY / NVIDIA_BASE_URL / NVIDIA_MODEL are not all set,
// the endpoints respond with a clean disabled-fallback and the audit keeps working.
let aiRouteIncluded = false;
try {
  const { aiAssistRouter } = await import('../backend/dist/routes/aiAssist.js');
  app.use('/api', aiAssistRouter);
  aiRouteIncluded = true;
  console.log('AI Assist route loaded');
} catch (err) {
  console.error('AI Assist route failed to load:', err.message);
}

// Build/runtime diagnostics — confirm the deployed container runs the latest code.
//
// `gitSha` is the repository identity half of the deployment parity gate
// REPO_SHA == APP_SHA == RUNNER_SHA. It is resolved ONCE, at start-up, from an
// environment value injected at build/deploy time; `git` is never executed.
// When no valid full SHA was injected it is reported as null — honestly
// unknown, which must fail the gate rather than be papered over.
const BUILD_TIME = new Date().toISOString();
const { gitSha, gitShaShort, gitShaSource } = resolveGitSha(process.env);
if (gitSha) {
  console.log(`Build identity: gitSha=${gitSha} (from ${gitShaSource})`);
} else {
  console.warn(
    'Build identity: gitSha is UNKNOWN — no valid full Git SHA was injected. ' +
      `Set one of ${GIT_SHA_ENV_VARS.slice(0, 3).join(', ')} at build/deploy time; ` +
      'the REPO_SHA == APP_SHA == RUNNER_SHA gate cannot pass without it.',
  );
}
app.get('/api/build-info', (_req, res) => {
  res.json({
    app: 'seo-analyzer',
    aiRouteIncluded,
    model: process.env.NVIDIA_MODEL || null,
    buildTime: BUILD_TIME,
    nodeEnv: process.env.NODE_ENV || null,
    // Added fields — all pre-existing fields above are unchanged.
    gitSha,
    gitShaShort,
    gitShaSource,
    nodeVersion: process.version,
  });
});

// Backward-compatible Supabase-style paths (if a reverse proxy sends these)
app.use('/functions/v1/seo-intelligence', seoIntelligenceRouter);
app.use('/functions/v1/seo-site-crawler', seoCrawlerRouter);

// Catch-all for unmatched /api routes — return clear 404 JSON
app.all('/api/*', (req, res) => {
  console.warn(`[404] No handler for ${req.method} ${req.url}`);
  res.status(404).json({ error: `Not found: ${req.method} ${req.url}` });
});

// --------------- Static files (Vite build output) ---------------
const distPath = join(__dirname, '..', 'dist');

if (_existsSync(distPath)) {
  app.use(express.static(distPath));

  // SPA fallback - serve index.html for all non-API routes
  app.get('*', (_req, res) => {
    res.sendFile(join(distPath, 'index.html'));
  });
  console.log('Serving static files from:', distPath);
} else {
  console.log('No dist/ folder found — run `npm run build` to build the frontend');
}

// --------------- Start ---------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
});
