/**
 * SEO Analyzer — Database Migration Runner
 *
 * Reads DATABASE_URL from environment and runs supabase/migrations/init.sql.
 * Safe to run multiple times — all SQL uses IF NOT EXISTS.
 *
 * Usage:
 *   node --env-file=.env scripts/migrate.js           ← run migration
 *   node --env-file=.env scripts/migrate.js --check   ← test connection + show tables
 *
 *   DATABASE_URL=postgresql://user:pass@host:5432/db node scripts/migrate.js
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

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

// ── Locate SQL file ───────────────────────────────────────────────

const sqlPath = join(__dirname, '..', 'supabase', 'migrations', 'init.sql');

if (!existsSync(sqlPath)) {
  err(`Migration file not found: ${sqlPath}`);
  err('Make sure you are running this from the project root.');
  process.exit(1);
}

const sql = readFileSync(sqlPath, 'utf8');

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
  ssl: DATABASE_URL.includes('sslmode=require') || DATABASE_URL.includes('supabase.co')
    ? { rejectUnauthorized: false }
    : false,
});

section('SEO Analyzer — Database Migration');
log('🔌', `Connecting to: ${dbHost}`);

try {
  await client.connect();
  ok(`Connected successfully`);

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
      console.log('  Table              Columns   Size');
      console.log('  ─────────────────────────────────────');
      for (const row of tablesRes.rows) {
        const exists = EXPECTED.includes(row.table_name);
        const icon = exists ? '✅' : '  ';
        console.log(`  ${icon} ${row.table_name.padEnd(18)} ${String(row.columns).padEnd(9)} ${row.size}`);
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
        console.log(`  ${table.padEnd(20)} ${r.rows[0].count} rows`);
      } catch {
        console.log(`  ${table.padEnd(20)} (table missing)`);
      }
    }
    console.log('');
    process.exit(0);
  }

  // ── Migration mode ────────────────────────────────────────────
  section('Running Migration');
  log('📄', `SQL file: ${sqlPath}`);
  log('📝', `SQL size: ${sql.length} bytes`);
  console.log('');

  await client.query(sql);

  // Verify tables were created
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

  // Show indexes
  const indexRes = await client.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public' AND indexname LIKE 'idx_%'
    ORDER BY indexname;
  `);

  if (indexRes.rows.length > 0) {
    console.log('');
    log('🗂️ ', `Indexes created: ${indexRes.rows.length}`);
    for (const row of indexRes.rows) {
      console.log(`     ✓ ${row.indexname}`);
    }
  }

  console.log('');
  ok('Migration complete — database is ready.');
  console.log('');
  console.log('  Next steps:');
  console.log('  1. npm run dev          ← start the app');
  console.log('  2. open http://localhost:5173');
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
