import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

type Site = { id: string; domain: string };

const sites: Site[] = [{ id: 'project-1', domain: 'example.com' }];
const transactionSql: string[] = [];
const backgroundSql: string[] = [];
const insertedResultUrls: string[] = [];
let runningAuditId: string | null = null;
let failSeedInsert = false;
let dbAvailable = true;
let runNumber = 0;

const client = {
  release: vi.fn(),
  async query(sql: string, params: unknown[] = []) {
    transactionSql.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [] };
    if (/pg_advisory_xact_lock/i.test(sql)) return { rows: [{}] };
    if (/SELECT id, domain FROM sites WHERE id/i.test(sql)) {
      const site = sites.find((row) => row.id === String(params[0]));
      return { rows: site ? [site] : [] };
    }
    if (/INSERT INTO sites/i.test(sql)) {
      const domain = String(params[0]);
      let site = sites.find((row) => row.domain === domain);
      if (!site) {
        site = { id: `legacy-${sites.length + 1}`, domain };
        sites.push(site);
      }
      return { rows: [site] };
    }
    if (/FROM audit_runs[\s\S]*status = 'RUNNING'/i.test(sql)) {
      return { rows: runningAuditId ? [{ id: runningAuditId }] : [] };
    }
    if (/DELETE FROM seed_urls/i.test(sql)) return { rows: [] };
    if (/INSERT INTO seed_urls/i.test(sql)) {
      if (failSeedInsert) throw new Error('injected seed insert failure');
      return { rows: [] };
    }
    if (/INSERT INTO audit_runs/i.test(sql)) return { rows: [{ id: `run-${++runNumber}` }] };
    throw new Error(`Unexpected transaction SQL: ${sql}`);
  },
};

const pool = {
  connect: vi.fn(async () => client),
  async query(sql: string, params: unknown[] = []) {
    backgroundSql.push(sql);
    if (/SELECT \* FROM audit_runs WHERE id/i.test(sql)) {
      return {
        rows: [{
          id: String(params[0]),
          site_id: 'project-1',
          status: 'COMPLETED',
          finished_at: '2026-08-09T12:00:00.000Z',
          site_checks: {
            robots: { status: 'FOUND' },
            sitemap: { status: 'FOUND' },
            newsSitemap: { status: 'NOT_FOUND' },
          },
        }],
      };
    }
    if (/SELECT \* FROM audit_results/i.test(sql)) return { rows: [] };
    if (/INSERT INTO audit_results/i.test(sql)) insertedResultUrls.push(String(params[1]));
    return { rows: [] };
  },
};

vi.mock('../../lib/db.js', () => ({
  getDb: () => (dbAvailable ? pool : null),
}));

vi.mock('../../services/checks/siteChecks.js', () => ({
  runSiteChecks: vi.fn(async () => ({
    robots: { status: 'FOUND', httpStatus: 200, sitemapsFound: [] },
    sitemap: { status: 'FOUND', discoveredFrom: 'robots', validatedRoot: '/sitemap.xml' },
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

function startAudit(body: unknown) {
  return fetch(`${base}/api/technical-analyzer/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const boundRequest = {
  expectedProjectId: 'project-1',
  homeUrl: 'https://www.example.com/',
  articleUrl: 'https://example.com/story',
};

beforeEach(() => {
  sites.splice(0, sites.length, { id: 'project-1', domain: 'example.com' });
  transactionSql.length = 0;
  backgroundSql.length = 0;
  insertedResultUrls.length = 0;
  runningAuditId = null;
  failSeedInsert = false;
  dbAvailable = true;
  runNumber = 0;
  client.release.mockClear();
  pool.connect.mockClear();
});

afterAll(() => server.close());

describe('POST /api/technical-analyzer/run project binding', () => {
  it('rejects a missing expected project and rolls back', async () => {
    const res = await startAudit({ ...boundRequest, expectedProjectId: 'missing' });
    expect(res.status).toBe(404);
    expect(transactionSql).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects a homepage that belongs to another project', async () => {
    const res = await startAudit({ ...boundRequest, homeUrl: 'https://other.test/' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('homeUrl must belong');
    expect(transactionSql).toContain('ROLLBACK');
  });

  it('rejects an article that belongs to another project', async () => {
    const res = await startAudit({ ...boundRequest, articleUrl: 'https://other.test/story' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('articleUrl must belong');
    expect(transactionSql).toContain('ROLLBACK');
  });

  it('returns the exact expected site ID and commits atomically', async () => {
    const res = await startAudit(boundRequest);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ siteId: 'project-1', auditRunId: 'run-1' });
    expect(transactionSql[0]).toBe('BEGIN');
    expect(transactionSql).toContain('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
    expect(transactionSql.some((sql) => /INSERT INTO sites/i.test(sql))).toBe(false);
    const lockAt = transactionSql.findIndex((sql) => /pg_advisory_xact_lock/i.test(sql));
    const siteAt = transactionSql.findIndex((sql) => /SELECT id, domain FROM sites/i.test(sql));
    const runningAt = transactionSql.findIndex((sql) => /FROM audit_runs/i.test(sql));
    const seedsAt = transactionSql.findIndex((sql) => /DELETE FROM seed_urls/i.test(sql));
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(siteAt);
    expect(siteAt).toBeLessThan(runningAt);
    expect(runningAt).toBeLessThan(seedsAt);
  });

  it('rejects an existing RUNNING audit with 409', async () => {
    runningAuditId = 'already-running';
    const res = await startAudit(boundRequest);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ siteId: 'project-1', auditRunId: 'already-running' });
    expect(transactionSql).toContain('ROLLBACK');
    expect(transactionSql.some((sql) => /DELETE FROM seed_urls/i.test(sql))).toBe(false);
  });

  it('rolls back a partial seed failure and never starts background work', async () => {
    failSeedInsert = true;
    const res = await startAudit(boundRequest);
    expect(res.status).toBe(500);
    expect(transactionSql).toContain('ROLLBACK');
    expect(transactionSql).not.toContain('COMMIT');
    expect(backgroundSql).toHaveLength(0);
  });

  it('audits the immutable submitted seed snapshot without re-reading seed_urls', async () => {
    const res = await startAudit({
      ...boundRequest,
      optionalUrls: { section: 'https://example.com/news' },
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(insertedResultUrls).toHaveLength(3));
    expect(insertedResultUrls).toEqual([
      'https://www.example.com/',
      'https://example.com/story',
      'https://example.com/news',
    ]);
    expect([...transactionSql, ...backgroundSql].some(
      (sql) => /SELECT url, page_type FROM seed_urls/i.test(sql),
    )).toBe(false);
  });

  it('preserves the normalized-domain upsert for a legacy manual caller', async () => {
    const res = await startAudit({
      homeUrl: 'https://www.example.com/',
      articleUrl: 'https://example.com/story',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ siteId: 'project-1' });
    expect(transactionSql.some((sql) => /INSERT INTO sites/i.test(sql))).toBe(true);
  });

  it('refuses a bound request when no database is configured', async () => {
    dbAvailable = false;
    const res = await startAudit(boundRequest);
    expect(res.status).toBe(503);
  });
});

describe('GET /api/audit-runs/:id/results evidence identity', () => {
  it('returns the owning site identity with the audit identity', async () => {
    const res = await fetch(`${base}/api/audit-runs/run-proof/results`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: 'run-proof',
      siteId: 'project-1',
      status: 'COMPLETED',
      finished_at: '2026-08-09T12:00:00.000Z',
    });
  });
});
