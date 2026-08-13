/**
 * GET /api/projects/:id pre-flight counts.
 *
 * The runner reads `running_count` before deciding whether to POST an audit and
 * skips the project when it is > 0. A crashed row left RUNNING forever would
 * therefore block that project permanently and the POST-side recovery would
 * never be reached. This route must count only NON-STALE running audits — while
 * staying strictly read-only.
 *
 * The pg pool is faked, so the SQL text itself is asserted alongside the
 * behavior: the fake cannot drift from the real statement unnoticed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { STALE_AUDIT_RUN_TIMEOUT_MINUTES } from '../../lib/staleAuditRuns.js';

type AuditRun = { id: string; site_id: string; status: string; started_at: Date };

const MINUTE = 60_000;
const site = { id: 'project-1', domain: 'example.com', project_name: 'Example', is_beta: false };
let auditRuns: AuditRun[] = [];
const executedSql: string[] = [];
const writeSql: string[] = [];

function fakeQuery(sql: string, params: unknown[] = []) {
  executedSql.push(sql);
  if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) writeSql.push(sql);

  if (/AS running_count/i.test(sql)) {
    const id = String(params[0]);
    if (id !== site.id) return Promise.resolve({ rows: [] });
    const cutoff = Date.now() - Number(params[1]) * MINUTE;
    const forSite = auditRuns.filter((run) => run.site_id === id);
    return Promise.resolve({
      rows: [{
        ...site,
        audit_count: forSite.length,
        completed_count: forSite.filter((r) => r.status === 'COMPLETED').length,
        running_count: forSite.filter(
          (r) => r.status === 'RUNNING' && r.started_at.getTime() >= cutoff,
        ).length,
        stale_running_count: forSite.filter(
          (r) => r.status === 'RUNNING' && r.started_at.getTime() < cutoff,
        ).length,
      }],
    });
  }

  return Promise.resolve({ rows: [] });
}

vi.mock('../../lib/db.js', () => ({ getDb: () => ({ query: fakeQuery }) }));

const { projectsRouter } = await import('../projects.js');

const app = express();
app.use(express.json());
app.use('/api', projectsRouter);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

const minutesAgo = (n: number) => new Date(Date.now() - n * MINUTE);
interface ProjectResponse {
  project: {
    audit_count: number;
    completed_count: number;
    running_count: number;
    stale_running_count: number;
  };
}
const getProject = (): Promise<ProjectResponse> =>
  fetch(`${base}/api/projects/${site.id}`).then((r) => r.json() as Promise<ProjectResponse>);

beforeEach(() => {
  auditRuns = [];
  executedSql.length = 0;
  writeSql.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/projects/:id running_count', () => {
  it('counts a fresh RUNNING audit as active', async () => {
    auditRuns.push({ id: 'fresh', site_id: site.id, status: 'RUNNING', started_at: minutesAgo(5) });

    const { project } = await getProject();

    expect(project.running_count).toBe(1);
    expect(project.stale_running_count).toBe(0);
  });

  it('reports no active running audit when only a stale row exists', async () => {
    auditRuns.push({ id: 'stale', site_id: site.id, status: 'RUNNING', started_at: minutesAgo(180) });

    const { project } = await getProject();

    // This is what unblocks the runner's pre-flight so it can reach POST,
    // where the authoritative recovery happens.
    expect(project.running_count).toBe(0);
    expect(project.stale_running_count).toBe(1);
  });

  it('separates fresh from stale when both exist', async () => {
    auditRuns.push(
      { id: 'stale', site_id: site.id, status: 'RUNNING', started_at: minutesAgo(240) },
      { id: 'fresh', site_id: site.id, status: 'RUNNING', started_at: minutesAgo(1) },
    );

    const { project } = await getProject();

    expect(project.running_count).toBe(1);
    expect(project.stale_running_count).toBe(1);
  });

  it('does not treat a run exactly at the cutoff boundary as stale', async () => {
    auditRuns.push({
      id: 'edge',
      site_id: site.id,
      status: 'RUNNING',
      started_at: minutesAgo(STALE_AUDIT_RUN_TIMEOUT_MINUTES - 1),
    });

    const { project } = await getProject();

    expect(project.running_count).toBe(1);
    expect(project.stale_running_count).toBe(0);
  });

  it('leaves COMPLETED and FAILED history out of both counts', async () => {
    auditRuns.push(
      { id: 'done', site_id: site.id, status: 'COMPLETED', started_at: minutesAgo(900) },
      { id: 'failed', site_id: site.id, status: 'FAILED', started_at: minutesAgo(800) },
    );

    const { project } = await getProject();

    expect(project.running_count).toBe(0);
    expect(project.stale_running_count).toBe(0);
    expect(project.completed_count).toBe(1);
    expect(project.audit_count).toBe(2);
  });

  it('stays strictly read-only — the pre-flight never recovers anything', async () => {
    const stale = { id: 'stale', site_id: site.id, status: 'RUNNING', started_at: minutesAgo(500) };
    auditRuns.push(stale);

    await getProject();

    expect(writeSql).toHaveLength(0);
    expect(stale.status).toBe('RUNNING');
  });

  it('sends the cutoff to PostgreSQL rather than filtering in JavaScript', async () => {
    await getProject();

    const sql = executedSql.find((s) => /AS running_count/i.test(s));
    expect(sql).toBeDefined();
    expect(sql).toMatch(/make_interval\(mins => \$2::int\)/);
    expect(sql).toMatch(/started_at >= NOW\(\) - make_interval/);
    expect(sql).toMatch(/started_at < NOW\(\) - make_interval/);
    expect(sql).toMatch(/AS stale_running_count/);
  });
});
