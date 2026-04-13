/**
 * SEO Analyzer — Database Migration Runner
 *
 * Discovers and runs ALL .sql files in supabase/migrations/ in alphabetical
 * order. Tracks applied files in a `schema_migrations` table — idempotent,
 * safe to run multiple times.
 *
 * Usage:
 *   node --env-file=.env scripts/migrate.js           ← run pending migrations
 *   node --env-file=.env scripts/migrate.js --check   ← test connection + show tables
 *
 *   DATABASE_URL=postgresql://user:pass@host:5432/db node scripts/migrate.js
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setDefaultResultOrder } from 'node:dns';
import pg from 'pg';

setDefaultResultOrder('ipv4first'); // prevent ENETUNREACH on IPv6-disabled container networks

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const CHECK_ONLY = process.argv.includes('--check');

// ── Helpers ──────────────────────────────────────────────────────

function log(icon, msg)  { console.log(`${icon}  ${msg}`); }
function err(msg)        { console.error(`❌  ${msg}`); }
function ok(msg)         { console.log(`✅  ${msg}`); }
function warn(msg)       { console.warn(`⚠️   ${msg}`); }
function section(title)  { console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`); }

// ── Validate env ─────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  err('DATABASE_URL is not set.');
  console.error('');
  console.error('  Option 1 (with .env file):');
  console.error('    node --env-file=.env scripts/migrate.js');
  console.error('');
  console.error('  Option 2 (inline):');
  console.error('    DATABASE_URL=postgresql://user:pass@localhost:5432/seo_analyzer node scripts/migrate.js');
  console.error('');
  process.exit(1);
}

// ── Discover migration files ──────────────────────────────────────

const migrationsDir = join(__dirname, '..', 'supabase', 'migrations');

if (!existsSync(migrationsDir)) {
  err(`Migrations directory not found: ${migrationsDir}`);
  process.exit(1);
}

const migrationFiles = readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort(); // alphabetical = chronological for timestamped filenames

if (migrationFiles.length === 0) {
  err('No .sql files found in supabase/migrations/');
  process.exit(1);
}

// ── Connect ───────────────────────────────────────────────────────

let dbHost = 'unknown';
try {
  const u = new URL(DATABASE_URL);
  dbHost = `${u.hostname}:${u.port || 5432}${u.pathname}`;
} catch {
  dbHost = DATABASE_URL.slice(0, 40) + '...';
}

const client = new Client({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: 8000,
  family: 4,  // force IPv4 — containers often can't reach IPv6 addresses
  ssl: DATABASE_URL.includes('sslmode=require') || DATABASE_URL.includes('supabase.co')
    ? { rejectUnauthorized: false }
    : false,
});

section('SEO Analyzer — Database Migration');
log('🔌', `Connecting to: ${dbHost}`);

try {
  await client.connect();
  ok('Connected successfully');

  // ── Check mode — show existing tables and exit ────────────────
  if (CHECK_ONLY) {
    section('Existing Tables');

    const tablesRes = await client.query(`
      SELECT
        t.table_name,
        pg_size_pretty(pg_total_relation_size('"' || t.table_name || '"')) AS size,
        (SELECT COUNT(*) FROM information_schema.columns c
         WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS columns
      FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name;
    `);

    const EXPECTED = ['sites', 'seed_urls', 'audit_runs', 'audit_results'];

    if (tablesRes.rows.length === 0) {
      warn('No tables found — run without --check to create them.');
    } else {
      console.log('');
      console.log('  Table                Columns   Size');
      console.log('  ───────────────────────────────────────');
      for (const row of tablesRes.rows) {
        const exists = EXPECTED.includes(row.table_name);
        const icon = exists ? '✅' : '  ';
        console.log(`  ${icon} ${row.table_name.padEnd(20)} ${String(row.columns).padEnd(9)} ${row.size}`);
      }
      console.log('');

      const missing = EXPECTED.filter(t => !tablesRes.rows.find(r => r.table_name === t));
      if (missing.length > 0) {
        warn(`Missing required tables: ${missing.join(', ')}`);
        warn('Run without --check to create them.');
      } else {
        ok('All required tables exist.');
      }
    }

    // Row counts
    section('Row Counts');
    for (const table of EXPECTED) {
      try {
        const r = await client.query(`SELECT COUNT(*) FROM "${table}"`);
        console.log(`  ${table.padEnd(22)} ${r.rows[0].count} rows`);
      } catch {
        console.log(`  ${table.padEnd(22)} (table missing)`);
      }
    }

    // Applied migrations
    section('Applied Migrations');
    try {
      const migRes = await client.query(
        `SELECT filename, applied_at FROM schema_migrations ORDER BY filename`,
      );
      if (migRes.rows.length === 0) {
        warn('schema_migrations table empty — run without --check to apply migrations.');
      } else {
        for (const row of migRes.rows) {
          const ts = new Date(row.applied_at).toISOString().slice(0, 19).replace('T', ' ');
          console.log(`  ✅ ${row.filename.padEnd(55)} ${ts}`);
        }
      }
    } catch {
      warn('schema_migrations table not found — run without --check first.');
    }

    console.log('');
    process.exit(0);
  }

  // ── Migration mode ────────────────────────────────────────────

  // Ensure tracking table exists (safe to run each time)
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Load already-applied filenames
  const appliedRes = await client.query(
    `SELECT filename FROM schema_migrations ORDER BY filename`,
  );
  const applied = new Set(appliedRes.rows.map(r => r.filename));

  const pending = migrationFiles.filter(f => !applied.has(f));

  section('Running Migrations');
  log('📁', `Migrations dir: ${migrationsDir}`);
  log('📋', `Total files:    ${migrationFiles.length}  (${applied.size} already applied, ${pending.length} pending)`);

  if (pending.length === 0) {
    console.log('');
    ok('Nothing to do — all migrations already applied.');
  } else {
    console.log('');
    for (const filename of pending) {
      const filePath = join(migrationsDir, filename);
      const sql = readFileSync(filePath, 'utf8');

      log('📄', `Applying: ${filename}  (${sql.length} bytes)`);

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
          [filename],
        );
        await client.query('COMMIT');
        ok(`Applied: ${filename}`);
      } catch (applyErr) {
        await client.query('ROLLBACK');
        err(`Failed to apply ${filename}: ${applyErr.message}`);
        throw applyErr;
      }
    }
  }

  // ── Verification ──────────────────────────────────────────────
  const verifyRes = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `);

  const created = verifyRes.rows.map(r => r.table_name);
  const required = ['sites', 'seed_urls', 'audit_runs', 'audit_results'];

  section('Verification');
  for (const table of required) {
    if (created.includes(table)) {
      ok(`Table: ${table}`);
    } else {
      err(`Table NOT found: ${table}`);
    }
  }

  // Columns added by project layer
  const colRes = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sites'
    ORDER BY ordinal_position;
  `);
  const cols = colRes.rows.map(r => r.column_name);
  const projectCols = ['project_name', 'website_url', 'last_audit_at'];
  for (const col of projectCols) {
    if (cols.includes(col)) {
      ok(`sites.${col} column exists`);
    } else {
      warn(`sites.${col} column missing — check migration 20260407000000_add_project_layer.sql`);
    }
  }

  // Indexes
  const indexRes = await client.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public' AND indexname LIKE 'idx_%'
    ORDER BY indexname;
  `);

  if (indexRes.rows.length > 0) {
    console.log('');
    log('🗂️ ', `Indexes: ${indexRes.rows.length}`);
    for (const row of indexRes.rows) {
      console.log(`     ✓ ${row.indexname}`);
    }
  }

  console.log('');
  ok('All migrations applied — database is ready.');
  console.log('');
  console.log('  Next steps:');
  console.log('  1. npm run build:backend   ← compile TypeScript');
  console.log('  2. npm run dev             ← start the app');
  console.log('  3. open http://localhost:5173');
  console.log('');

} catch (error) {
  console.log('');
  err(`Migration failed: ${error.message}`);
  console.error('');

  // Helpful hints for common errors
  if (error.message.includes('ECONNREFUSED')) {
    warn('PostgreSQL is not running or the host/port is wrong.');
    console.error('  Fix: sudo systemctl start postgresql');
    console.error('       or check your DATABASE_URL host and port.');
  } else if (error.message.includes('password authentication')) {
    warn('Wrong username or password.');
    console.error('  Fix: check POSTGRES_USER and POSTGRES_PASSWORD in .env');
  } else if (error.message.includes('does not exist') && error.message.includes('database')) {
    warn('Database does not exist yet.');
    console.error('  Fix: sudo -u postgres psql -c "CREATE DATABASE seo_analyzer OWNER seo_user;"');
  } else if (error.message.includes('role') && error.message.includes('does not exist')) {
    warn('PostgreSQL user does not exist.');
    console.error('  Fix: sudo -u postgres psql -c "CREATE USER seo_user WITH PASSWORD \'changeme\';"');
  } else if (error.message.includes('timeout')) {
    warn('Connection timed out — check that PostgreSQL is reachable.');
  }

  process.exit(1);
} finally {
  await client.end();
}
