/**
 * PostgreSQL connection pool.
 *
 * Reads DATABASE_URL from the environment.
 * Returns null when not configured so the server falls back to in-memory mode.
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

  // pg-connection-string currently treats sslmode=require as verify-full, which
  // rejects self-signed certificates (Dublyo, local dev). Strip sslmode from the
  // URL and set ssl explicitly so we control certificate verification ourselves.
  let connectionString = url;
  let useSSL = false;
  try {
    const parsed = new URL(url);
    const sslmode = parsed.searchParams.get('sslmode');
    useSSL = sslmode !== 'disable';
    parsed.searchParams.delete('sslmode');
    connectionString = parsed.toString();
  } catch {
    useSSL = !url.includes('sslmode=disable');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const poolConfig: any = {
    connectionString,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    family: 4,              // force IPv4 — containers often can't reach IPv6 addresses
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
  _pool = new Pool(poolConfig);

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
