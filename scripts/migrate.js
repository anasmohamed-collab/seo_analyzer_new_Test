/**
 * Database migration runner.
 * Runs supabase/migrations/init.sql against DATABASE_URL.
 *
 * Usage:
 *   node --env-file=.env scripts/migrate.js
 *   DATABASE_URL=postgresql://... node scripts/migrate.js
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌  DATABASE_URL is not set.');
  console.error('    Usage: DATABASE_URL=postgresql://user:pass@host:5432/db node scripts/migrate.js');
  process.exit(1);
}

const sqlPath = join(__dirname, '..', 'supabase', 'migrations', 'init.sql');
const sql = readFileSync(sqlPath, 'utf8');

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : false,
});

try {
  console.log('🔌  Connecting to database…');
  await client.connect();

  const { hostname, port, pathname } = new URL(DATABASE_URL);
  console.log(`✅  Connected: ${hostname}:${port || 5432}${pathname}`);

  console.log('🚀  Running migrations…');
  await client.query(sql);

  console.log('✅  Migration complete — all tables and indexes are ready.');
} catch (err) {
  console.error('❌  Migration failed:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
