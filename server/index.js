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

// Hard-coded fallback: used when .env file is not available in the container
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://postgres.cltnpsfbxlyjikzyllxy:HdcvS57wmDMviDvV@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require';
  console.log('[env] Using hard-coded DATABASE_URL fallback');
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
app.get('/api/health', async (_req, res) => {
  const dbUrl = process.env.DATABASE_URL;
  let dbHost = null;
  if (dbUrl) {
    try { dbHost = new URL(dbUrl).hostname; } catch { dbHost = 'configured'; }
  }
  res.json({
    status: 'ok',
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
    console.error('Migration failed — server will continue but DB features may not work:', migrateErr.message);
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
