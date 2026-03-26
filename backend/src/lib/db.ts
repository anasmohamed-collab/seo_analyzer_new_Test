/**
 * PostgreSQL connection pool.
 *
 * Reads DATABASE_URL from the environment.
 * Returns null when not configured so the server falls back to in-memory mode.
 *
 * DATABASE_URL format:
 *   postgresql://user:password@host:5432/dbname
 *   postgresql://user:password@host:5432/dbname?sslmode=require   (remote / cloud)
 */

import process from 'node:process';
import pg from 'pg';

const { Pool } = pg;

export type DbPool = pg.Pool;

let _pool: pg.Pool | null = null;
let _checked = false;

export function getDb(): pg.Pool | null {
  if (_checked) return _pool;
  _checked = true;

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('[db] No DATABASE_URL — running in-memory mode (results not persisted)');
    return null;
  }

  _pool = new Pool({
    connectionString: url,
    // Allow self-signed certs on local Linux servers; for cloud with real certs set to 'require'
    ssl: url.includes('sslmode=require') ? { rejectUnauthorized: false } : false,
    max: 10,                // max pool size
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  _pool.on('error', (err) => {
    console.error('[db] Unexpected pool error:', err.message);
  });

  console.log('[db] PostgreSQL pool initialized');
  return _pool;
}

/** Gracefully end the pool on process exit. */
export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _checked = false;
  }
}
