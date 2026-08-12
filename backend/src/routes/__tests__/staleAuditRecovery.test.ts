/**
 * Stale `audit_runs` recovery — application (PostgreSQL) side.
 *
 * The pg pool is replaced by a small in-memory simulation of the `audit_runs`
 * table so the recovery UPDATE, the post-recovery RUNNING re-check, the 409
 * path, and the lock ordering can all be asserted deterministically without a
 * database. The simulation honors the same predicates the real SQL uses:
 * `status = 'RUNNING'` plus a `started_at` cutoff.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

import {
  MIN_STALE_AUDIT_RUN_TIMEOUT_MINUTES,
  STALE_AUDIT_RUN_TIMEOUT_MINUTES,
  resolveStaleAuditTimeoutMinutes,
} from '../../lib/staleAuditRuns.js';

type Site = { id: string; domain: string; is_beta: boolean };
type AuditRun = {
  id: string;
  site_id: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  started_at: Date;
  finished_at: Date | null;
};

const MINUTE = 60_000;

const sites: Site[] = [{ id: 'project-1', domain: 'example.com', is_beta: false }];
let auditRuns: AuditRun[] = [];
let transactionSql: string[] = [];
let runNumber = 0;
const warnings: string[] = [];

function cutoffFor(minutes: number): number {
  return Date.now() - minutes * MINUTE;
}

const client = {
  release: vi.fn(),
  async query(sql: string, params: unknown[] = []) {
    transactionSql.push(sql.trim().split('\n')[0].trim());
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [], rowCount: 0 };
    if (/pg_advisory_xact_lock/i.test(sql)) return { rows: [{}], rowCount: 1 };

    if (/SELECT id, domain, is_beta FROM sites WHERE id/i.test(sql)) {
      const site = sites.find((row) => row.id === String(params[0]));
      return { rows: site ? [site] : [], rowCount: site ? 1 : 0 };
    }

    // Stale recovery: RUNNING + started_at older than the cutoff → FAILED.
    if (/UPDATE audit_runs[\s\S]*status = 'FAILED'[\s\S]*started_at < NOW\(\)/i.test(sql)) {
      const siteId = String(params[0]);
      const cutoff = cutoffFor(Number(params[1]));
      const recovered = auditRuns.filter(
        (run) => run.site_id === siteId && run.status === 'RUNNING' && run.started_at.getTime() < cutoff,
      );
      for (const run of recovered) {
        run.status = 'FAILED';
        run.finished_at = new Date();
      }
      return {
        rows: recovered.map((run) => ({ id: run.id, started_at: run.started_at })),
        rowCount: recovered.length,
      };
    }

    if (/SELECT id FROM audit_runs[\s\S]*status = 'RUNNING'/i.test(sql)) {
      const siteId = String(params[0]);
      const running = auditRuns
        .filter((run) => run.site_id === siteId && run.status === 'RUNNING')
        .sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
      return { rows: running.slice(0, 1).map((run) => ({ id: run.id })), rowCount: running.length ? 1 : 0 };
    }

    if (/DELETE FROM seed_urls/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO seed_urls/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO audit_runs/i.test(sql)) {
      const run: AuditRun = {
        id: `run-${++runNumber}`,
        site_id: String(params[0]),
        status: 'RUNNING',
        started_at: new Date(),
        finished_at: null,
      };
      auditRuns.push(run);
      return { rows: [{ id: run.id }], rowCount: 1 };
    }
    throw new Error(`Unexpected transaction SQL: ${sql}`);
  },
};

const pool = {
  connect: vi.fn(async () => client),
  async query(sql: string, params: unknown[] = []) {
    // Background worker writes, all conditional on status = 'RUNNING'.
    if (/UPDATE audit_runs SET status = 'COMPLETED'[\s\S]*status = 'RUNNING'/i.test(sql)) {
      const run = auditRuns.find((r) => r.id === String(params[0]) && r.status === 'RUNNING');
      if (!run) return { rows: [], rowCount: 0 };
      run.status = 'COMPLETED';
      run.finished_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE audit_runs SET status = 'FAILED'[\s\S]*status = 'RUNNING'/i.test(sql)) {
      const run = auditRuns.find((r) => r.id === String(params[0]) && r.status === 'RUNNING');
      if (!run) return { rows: [], rowCount: 0 };
      run.status = 'FAILED';
      run.finished_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
};

vi.mock('../../lib/db.js', () => ({ getDb: () => pool }));

vi.mock('../../services/checks/siteChecks.js', () => ({
  runSiteChecks: vi.fn(async () => ({
    robots: { status: 'FOUND', httpStatus: 200, sitemapsFound: [], sitemapDirectives: [] },
    sitemap: { status: 'FOUND', discoveredFrom: 'robots', validatedRoot: 'urlset' },
    newsSitemap: { status: 'NOT_FOUND' },
  })),
}));

vi.mock('../../services/fetch/fetchEngine.js', () => ({
  runFetchEngine: vi.fn(async (url: string) => ({
    fetchOk: true,
    html: '<!doctype html><html><head><title>Test page</title></head><body><main>Enough real content for checks.</main></body></html>',
    httpStatus: 200,
    contentType: 'text/html',
    xRobotsTag: '',
    finalUrl: url,
    redirectChain: [],
    elapsedMs: 5,
    profilesTried: [],
    winningProfile: 'chrome-win10',
    blockedConfidence: 'NONE',
    blockedReason: null,
    challengeDetected: false,
  })),
}));

const { auditRunsRouter } = await import('../auditRunsSimple.js');

const app = express();
app.use(express.json());
app.use('/api', auditRunsRouter);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

const request = {
  expectedProjectId: 'project-1',
  homeUrl: 'https://www.example.com/',
  articleUrl: 'https://example.com/story',
};

function startAudit() {
  return fetch(`${base}/api/technical-analyzer/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
}

function addRun(over: Partial<AuditRun> & { id: string }): AuditRun {
  const run: AuditRun = {
    site_id: 'project-1',
    status: 'RUNNING',
    started_at: new Date(),
    finished_at: null,
    ...over,
  };
  auditRuns.push(run);
  return run;
}

const minutesAgo = (n: number) => new Date(Date.now() - n * MINUTE);

beforeEach(() => {
  auditRuns = [];
  transactionSql = [];
  warnings.length = 0;
  runNumber = 0;
  client.release.mockClear();
  pool.connect.mockClear();
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  server.close();
  vi.restoreAllMocks();
});

describe('stale timeout policy', () => {
  it('defaults to a conservative 60 minutes', () => {
    expect(STALE_AUDIT_RUN_TIMEOUT_MINUTES).toBe(60);
    expect(resolveStaleAuditTimeoutMinutes(undefined).minutes).toBe(60);
    expect(resolveStaleAuditTimeoutMinutes('').minutes).toBe(60);
    expect(resolveStaleAuditTimeoutMinutes('  ').minutes).toBe(60);
  });

  it('accepts a valid configured value at or above the floor', () => {
    expect(resolveStaleAuditTimeoutMinutes('90')).toEqual({ minutes: 90 });
    expect(resolveStaleAuditTimeoutMinutes(String(MIN_STALE_AUDIT_RUN_TIMEOUT_MINUTES)))
      .toEqual({ minutes: MIN_STALE_AUDIT_RUN_TIMEOUT_MINUTES });
  });

  it('refuses to become more aggressive than the floor', () => {
    for (const value of ['1', '5', '59', '0']) {
      const resolved = resolveStaleAuditTimeoutMinutes(value);
      expect(resolved.minutes).toBe(STALE_AUDIT_RUN_TIMEOUT_MINUTES);
      expect(resolved.warning).toMatch(/at least 60 minutes/);
    }
  });

  it('rejects malformed and absurd values without throwing', () => {
    for (const value of ['abc', '-10', '12.5', '99999999']) {
      const resolved = resolveStaleAuditTimeoutMinutes(value);
      expect(resolved.minutes).toBe(STALE_AUDIT_RUN_TIMEOUT_MINUTES);
      expect(resolved.warning).toBeTruthy();
    }
  });
});

describe('POST /api/technical-analyzer/run stale RUNNING recovery', () => {
  it('leaves a fresh RUNNING audit alone and still returns 409', async () => {
    const fresh = addRun({ id: 'fresh', started_at: minutesAgo(5) });

    const res = await startAudit();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ auditRunId: 'fresh', siteId: 'project-1' });
    expect(fresh.status).toBe('RUNNING');
    expect(fresh.finished_at).toBeNull();
    expect(auditRuns).toHaveLength(1);
    expect(transactionSql).toContain('ROLLBACK');
  });

  it('recovers a stale RUNNING audit as FAILED and creates a replacement run', async () => {
    const stale = addRun({ id: 'stale', started_at: minutesAgo(180) });

    const res = await startAudit();

    expect(res.status).toBe(200);
    expect(stale.status).toBe('FAILED');
    expect(stale.finished_at).not.toBeNull();
    const replacement = auditRuns.find((run) => run.id !== 'stale');
    expect(replacement).toBeDefined();
    expect(await res.json()).toMatchObject({ siteId: 'project-1', auditRunId: replacement?.id });
    // The replacement is a genuinely new row — the stale row was not reused.
    expect(replacement?.id).not.toBe('stale');
    expect(replacement?.started_at.getTime()).toBeGreaterThan(stale.started_at.getTime());
  });

  it('logs the recovered run ID, site ID, age, cutoff, and that a replacement is allowed', async () => {
    addRun({ id: 'stale-logged', started_at: minutesAgo(125) });

    await startAudit();

    const line = warnings.find((w) => w.includes('Recovered stale audit run'));
    expect(line).toBeDefined();
    expect(line).toContain('stale-logged');
    expect(line).toContain('project-1');
    expect(line).toMatch(/RUNNING for 12[45] minute\(s\)/);
    expect(line).toContain('cutoff 60 minute(s)');
    expect(line).toContain('a replacement audit is now allowed');
    // Nothing sensitive is ever echoed into the recovery log.
    expect(line).not.toMatch(/password|token|secret|DATABASE_URL/i);
  });

  it('never rewrites COMPLETED or already-FAILED history', async () => {
    const completed = addRun({ id: 'done', status: 'COMPLETED', started_at: minutesAgo(500), finished_at: minutesAgo(499) });
    const failed = addRun({ id: 'failed', status: 'FAILED', started_at: minutesAgo(400), finished_at: minutesAgo(399) });
    const completedFinishedAt = completed.finished_at;
    const failedFinishedAt = failed.finished_at;

    const res = await startAudit();

    expect(res.status).toBe(200);
    expect(completed.status).toBe('COMPLETED');
    expect(completed.finished_at).toBe(completedFinishedAt);
    expect(failed.status).toBe('FAILED');
    expect(failed.finished_at).toBe(failedFinishedAt);
  });

  it('still returns 409 when a fresh RUNNING audit coexists with a stale one', async () => {
    const stale = addRun({ id: 'stale', started_at: minutesAgo(300) });
    const fresh = addRun({ id: 'fresh', started_at: minutesAgo(2) });

    const res = await startAudit();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ auditRunId: 'fresh' });
    expect(stale.status).toBe('FAILED'); // the stale row is still cleaned up
    expect(fresh.status).toBe('RUNNING');
  });

  it('keeps the transaction and lock ordering unchanged', async () => {
    addRun({ id: 'stale', started_at: minutesAgo(200) });

    await startAudit();

    const order = transactionSql.filter((sql) =>
      /^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql) ||
      /pg_advisory_xact_lock/i.test(sql) ||
      /SELECT id, domain, is_beta FROM sites/i.test(sql) ||
      /^UPDATE audit_runs$/i.test(sql) ||
      /^SELECT id FROM audit_runs$/i.test(sql),
    );
    expect(order[0]).toBe('BEGIN');
    expect(order[1]).toMatch(/pg_advisory_xact_lock/);
    expect(order[2]).toMatch(/SELECT id, domain, is_beta FROM sites/);
    // Recovery sits between the site row lock and the RUNNING re-check.
    expect(order[3]).toMatch(/^UPDATE audit_runs$/);
    expect(order[4]).toMatch(/^SELECT id FROM audit_runs$/);
    expect(order.at(-1)).toBe('COMMIT');
  });
});

describe('delayed background completion cannot resurrect a recovered run', () => {
  it('leaves a recovered FAILED run FAILED when its late completion lands', async () => {
    const recovered = addRun({ id: 'recovered', status: 'FAILED', started_at: minutesAgo(200), finished_at: minutesAgo(1) });

    const result = await pool.query(
      `UPDATE audit_runs SET status = 'COMPLETED', finished_at = NOW()
        WHERE id = $1 AND status = 'RUNNING'`,
      ['recovered'],
    );

    expect(result.rowCount).toBe(0);
    expect(recovered.status).toBe('FAILED');
  });

  it('leaves a recovered FAILED run untouched when its late failure lands', async () => {
    const recovered = addRun({ id: 'recovered-2', status: 'FAILED', started_at: minutesAgo(200), finished_at: minutesAgo(1) });
    const finishedAt = recovered.finished_at;

    const result = await pool.query(
      `UPDATE audit_runs SET status = 'FAILED', finished_at = NOW()
        WHERE id = $1 AND status = 'RUNNING'`,
      ['recovered-2'],
    );

    expect(result.rowCount).toBe(0);
    expect(recovered.finished_at).toBe(finishedAt);
  });
});
