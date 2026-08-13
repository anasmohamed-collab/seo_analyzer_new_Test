/**
 * Route-level tests for POST /api/projects and the GET /api/projects ordering.
 *
 * The pg pool is replaced by a shared fake that emulates the documented
 * semantics of both statements in projects.ts — the legacy upsert
 * (ON CONFLICT (domain) DO UPDATE, COALESCE on last_form_values, `xmax = 0` as
 * the created flag) and the create-only insert (ON CONFLICT (domain) DO
 * NOTHING). The fake lets us assert the HTTP contract without a live database;
 * the SQL text itself is asserted separately so the fake cannot drift from the
 * real statements.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { createFakeSitesDb, type SiteRow } from './fakeSitesDb.js';

const db = createFakeSitesDb();
const sites = db.sites;
const executedSql = db.executedSql;

vi.mock('../../lib/db.js', () => ({
  getDb: () => (db.available ? { query: db.query } : null),
}));

// Imported after the mock is registered.
const { projectsRouter } = await import('../projects.js');

// ── Test server ───────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/api', projectsRouter);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

interface CreateResponse {
  project: SiteRow;
  created: boolean;
  automation_ready: boolean;
}

interface ErrorResponse {
  error: string;
}

interface ListResponse {
  projects: SiteRow[];
}

function postProject(body: unknown) {
  return fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patchProject(id: string, body: unknown) {
  return fetch(`${base}/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patchFormValues(id: string, body: unknown) {
  return fetch(`${base}/api/projects/${id}/form-values`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createProject(body: unknown): Promise<CreateResponse> {
  return json<CreateResponse>(await postProject(body));
}

beforeEach(() => {
  db.reset();
});

// ── Tests ─────────────────────────────────────────────────────────

describe('POST /api/projects — created vs updated', () => {
  it('returns 201 and created:true for a new domain', async () => {
    const res = await postProject({ website_url: 'https://example.com' });
    expect(res.status).toBe(201);

    const body = await json<CreateResponse>(res);
    expect(body.created).toBe(true);
    expect(body.project.domain).toBe('example.com');
  });

  it('returns 200 and created:false for an existing normalized domain', async () => {
    await postProject({ website_url: 'https://example.com' });
    const res = await postProject({ website_url: 'https://www.example.com' });

    expect(res.status).toBe(200);
    expect((await json<CreateResponse>(res)).created).toBe(false);
    expect(sites).toHaveLength(1);
  });

  it('preserves the existing project id when a domain is re-submitted', async () => {
    const first = await createProject({ website_url: 'https://example.com' });
    const second = await createProject({
      website_url: 'www.example.com',
      project_name: 'Renamed',
    });

    expect(second.project.id).toBe(first.project.id);
    expect(second.project.project_name).toBe('Renamed');
  });

  it('keeps a different subdomain as a separate project', async () => {
    await postProject({ website_url: 'https://example.com' });
    const res = await postProject({ website_url: 'https://blog.example.com' });

    expect(res.status).toBe(201);
    expect(sites).toHaveLength(2);
  });
});

describe('project environment classification', () => {
  it('defaults an existing-compatible create request to Production', async () => {
    const body = await createProject({ website_url: 'https://example.com' });
    expect(body.project.is_beta).toBe(false);
  });

  it('persists a new Beta project', async () => {
    const body = await createProject({
      website_url: 'https://beta.example.com',
      is_beta: true,
    });
    expect(body.project.is_beta).toBe(true);

    const listed = await json<ListResponse>(await fetch(`${base}/api/projects`));
    expect(listed.projects[0].is_beta).toBe(true);
  });

  it('preserves an existing Beta classification when an old API client omits the flag', async () => {
    await postProject({ website_url: 'https://beta.example.com', is_beta: true });
    const body = await createProject({ website_url: 'https://beta.example.com', project_name: 'Renamed' });

    expect(body.created).toBe(false);
    expect(body.project.is_beta).toBe(true);
  });

  it('lets PATCH update classification without breaking rename-only requests', async () => {
    const created = await createProject({ website_url: 'https://example.com' });

    const betaRes = await patchProject(created.project.id, { is_beta: true });
    expect(betaRes.status).toBe(200);
    expect((await json<CreateResponse>(betaRes)).project.is_beta).toBe(true);

    const renameRes = await patchProject(created.project.id, { project_name: 'Renamed' });
    expect(renameRes.status).toBe(200);
    const renamed = await json<CreateResponse>(renameRes);
    expect(renamed.project.project_name).toBe('Renamed');
    expect(renamed.project.is_beta).toBe(true);
  });
});

describe('POST /api/projects — audit configuration', () => {
  const config = {
    homeUrl: 'https://example.com/',
    articleUrl: 'https://example.com/a-story',
  };

  it('reports automation_ready:false when configuration is omitted', async () => {
    const body = await createProject({ website_url: 'https://example.com' });
    expect(body.automation_ready).toBe(false);
    expect(body.project.last_form_values).toBeNull();
  });

  it('stores the configuration and reports automation_ready:true', async () => {
    const body = await createProject({ website_url: 'https://example.com', ...config });
    expect(body.automation_ready).toBe(true);
    expect(body.project.last_form_values).toEqual(config);
  });

  it('does not erase existing configuration when the new request omits it', async () => {
    await postProject({ website_url: 'https://example.com', ...config });
    const body = await createProject({ website_url: 'https://example.com' });

    expect(body.created).toBe(false);
    expect(body.project.last_form_values).toEqual(config);
    expect(body.automation_ready).toBe(true);
  });

  it('replaces existing configuration when valid new configuration is supplied', async () => {
    await postProject({ website_url: 'https://example.com', ...config });
    const body = await createProject({
      website_url: 'https://example.com',
      homeUrl: 'https://example.com/home',
      articleUrl: 'https://example.com/newer-story',
    });

    expect(body.project.last_form_values).toEqual({
      homeUrl: 'https://example.com/home',
      articleUrl: 'https://example.com/newer-story',
    });
  });

  it('rejects cross-domain audit URLs with 400', async () => {
    const res = await postProject({
      website_url: 'https://example.com',
      homeUrl: 'https://example.com/',
      articleUrl: 'https://other.com/a-story',
    });

    expect(res.status).toBe(400);
    expect((await json<ErrorResponse>(res)).error).toContain('articleUrl must belong to example.com');
    expect(sites).toHaveLength(0);
  });
});

describe('POST /api/projects — URL validation', () => {
  it('accepts a scheme-less website_url', async () => {
    const res = await postProject({ website_url: 'example.com' });
    expect(res.status).toBe(201);
    expect((await json<CreateResponse>(res)).project.website_url).toBe('https://example.com/');
  });

  it('rejects an unsupported protocol with 400', async () => {
    const res = await postProject({ website_url: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
    expect((await json<ErrorResponse>(res)).error).toContain('only http and https');
  });

  it('rejects a missing website_url with 400', async () => {
    const res = await postProject({});
    expect(res.status).toBe(400);
    expect((await json<ErrorResponse>(res)).error).toBe('website_url is required');
  });
});

describe('project list ordering', () => {
  it('orders by most recent activity, not by last_audit_at with NULLS LAST', async () => {
    await fetch(`${base}/api/projects`);
    const listSql = executedSql.find((s) => /FROM sites s/i.test(s)) ?? '';

    expect(listSql).toMatch(/GREATEST\(/);
    expect(listSql).toMatch(/COALESCE\(s\.last_audit_at, s\.created_at::timestamptz\)/);
    // The old ordering pushed every never-audited project below every audited one.
    expect(listSql).not.toMatch(/NULLS LAST/);
  });

  it('returns a newly created project in the list', async () => {
    await postProject({ website_url: 'https://brand-new.test' });
    const body = await json<ListResponse>(await fetch(`${base}/api/projects`));

    expect(body.projects.map((p) => p.domain)).toContain('brand-new.test');
  });
});

describe('PATCH /api/projects/:id/form-values', () => {
  it('requires a complete homeUrl + articleUrl pair', async () => {
    const created = await createProject({ website_url: 'https://example.com' });
    const res = await patchFormValues(created.project.id, { homeUrl: 'https://example.com/' });

    expect(res.status).toBe(400);
    expect((await json<ErrorResponse>(res)).error).toContain('articleUrl');
    expect(sites[0].last_form_values).toBeNull();
  });

  it('rejects cross-domain configuration', async () => {
    const created = await createProject({ website_url: 'https://example.com' });
    const res = await patchFormValues(created.project.id, {
      homeUrl: 'https://example.com/',
      articleUrl: 'https://other.test/story',
    });

    expect(res.status).toBe(400);
    expect((await json<ErrorResponse>(res)).error).toContain('must belong to example.com');
  });

  it('replaces configuration and returns automation readiness', async () => {
    const created = await createProject({
      website_url: 'https://example.com',
      homeUrl: 'https://example.com/',
      articleUrl: 'https://example.com/old',
      sectionUrl: 'https://example.com/section',
    });
    const res = await patchFormValues(created.project.id, {
      homeUrl: 'https://www.example.com/',
      articleUrl: 'https://example.com/new',
    });

    expect(res.status).toBe(200);
    const body = await json<CreateResponse>(res);
    expect(body.automation_ready).toBe(true);
    expect(body.project.last_form_values).toEqual({
      homeUrl: 'https://www.example.com/',
      articleUrl: 'https://example.com/new',
    });
  });

  it('returns 404 for a missing project', async () => {
    const res = await patchFormValues('missing', {
      homeUrl: 'https://example.com/',
      articleUrl: 'https://example.com/story',
    });
    expect(res.status).toBe(404);
  });
});

// ── create-only contract ──────────────────────────────────────────

describe('POST /api/projects — create_only contract', () => {
  const createOnly = (body: Record<string, unknown>) =>
    postProject({ ...body, create_only: true });

  it('uses an atomic ON CONFLICT (domain) DO NOTHING insert, never an UPDATE', async () => {
    await createOnly({ website_url: 'https://example.com' });
    const sql = executedSql.find((s) => /INSERT INTO sites/i.test(s)) ?? '';

    expect(sql).toMatch(/ON CONFLICT \(domain\)\s+DO NOTHING/i);
    expect(sql).toMatch(/RETURNING \*/i);
    expect(sql).not.toMatch(/DO UPDATE/i);
    // A check-then-write would need a prior SELECT on the domain.
    expect(executedSql.filter((s) => /SELECT/i.test(s))).toHaveLength(0);
  });

  it('returns 201 with created:true for a new domain', async () => {
    const res = await createOnly({ website_url: 'https://example.com' });
    expect(res.status).toBe(201);

    const body = await json<CreateResponse & { conflict: boolean }>(res);
    expect(body.created).toBe(true);
    expect(body.conflict).toBe(false);
    expect(body.project.domain).toBe('example.com');
  });

  it('creates only the minimum project identity — no audit configuration, no beta guess', async () => {
    const body = await json<CreateResponse>(
      await createOnly({ website_url: 'https://beta-looking.example.com', project_name: 'Example' }),
    );

    expect(body.project.last_form_values).toBeNull();
    expect(body.automation_ready).toBe(false);
    expect(body.project.is_beta).toBe(false);
    expect(body.project.last_audit_at).toBeNull();

    type ListedProject = SiteRow & {
      audit_count: number;
      completed_count: number;
      automation_ready: boolean;
    };
    const listed = await json<{ projects: ListedProject[] }>(await fetch(`${base}/api/projects`));
    const created = listed.projects.find((p) => p.domain === 'beta-looking.example.com')!;
    expect(created.audit_count).toBe(0);
    expect(created.completed_count).toBe(0);
    expect(created.automation_ready).toBe(false);
  });

  it('returns 409 and leaves every field of the existing project untouched', async () => {
    const existing = db.seed({
      domain: 'example.com',
      project_name: 'Hand-Curated Name',
      website_url: 'https://example.com/',
      is_beta: true,
      last_form_values: { homeUrl: 'https://example.com/', articleUrl: 'https://example.com/story' },
    });
    const before = db.snapshot();

    const res = await createOnly({ website_url: 'https://example.com', project_name: 'Imported Name' });
    expect(res.status).toBe(409);

    const body = await json<{ conflict: boolean; created: boolean; existing_project_id: string }>(res);
    expect(body.conflict).toBe(true);
    expect(body.created).toBe(false);
    expect(body.existing_project_id).toBe(existing.id);

    // Byte-for-byte identical, including updated_at.
    expect(db.snapshot()).toEqual(before);
    expect(executedSql.some((s) => /DO UPDATE/i.test(s))).toBe(false);
  });

  it('treats a www variant as the same canonical project and conflicts', async () => {
    await createOnly({ website_url: 'https://example.com' });
    const before = db.snapshot();

    const res = await createOnly({ website_url: 'https://www.example.com' });
    expect(res.status).toBe(409);
    expect(sites).toHaveLength(1);
    expect(db.snapshot()).toEqual(before);
  });

  it('is idempotent — a repeated create-only request changes nothing', async () => {
    expect((await createOnly({ website_url: 'https://example.com' })).status).toBe(201);
    const after1 = db.snapshot();

    expect((await createOnly({ website_url: 'https://example.com' })).status).toBe(409);
    expect((await createOnly({ website_url: 'https://example.com' })).status).toBe(409);
    expect(db.snapshot()).toEqual(after1);
  });

  it('rejects audit configuration with 400 and writes nothing', async () => {
    const res = await createOnly({
      website_url: 'https://example.com',
      homeUrl: 'https://example.com/',
      articleUrl: 'https://example.com/a-story',
    });

    expect(res.status).toBe(400);
    expect((await json<ErrorResponse>(res)).error).toContain('must not carry audit configuration');
    expect(sites).toHaveLength(0);
  });

  it('rejects a non-boolean create_only with 400', async () => {
    const res = await postProject({ website_url: 'https://example.com', create_only: 'yes' });
    expect(res.status).toBe(400);
    expect((await json<ErrorResponse>(res)).error).toContain('create_only must be a boolean');
    expect(sites).toHaveLength(0);
  });

  it('leaves the legacy upsert behavior unchanged for callers that omit create_only', async () => {
    await postProject({ website_url: 'https://example.com', project_name: 'First' });
    const res = await postProject({ website_url: 'https://example.com', project_name: 'Second' });

    expect(res.status).toBe(200);
    const body = await json<CreateResponse>(res);
    expect(body.created).toBe(false);
    expect(body.project.project_name).toBe('Second');
  });

  it('honours an explicit create_only:false as the legacy upsert', async () => {
    await postProject({ website_url: 'https://example.com', project_name: 'First' });
    const res = await postProject({
      website_url: 'https://example.com',
      project_name: 'Second',
      create_only: false,
    });

    expect(res.status).toBe(200);
    expect((await json<CreateResponse>(res)).project.project_name).toBe('Second');
  });
});

describe('no database configured', () => {
  it('returns 501 from POST /api/projects', async () => {
    db.available = false;
    const res = await postProject({ website_url: 'https://example.com' });

    expect(res.status).toBe(501);
    expect((await json<ErrorResponse>(res)).error).toContain('Database required');
  });

  it('returns 501 from GET /api/projects', async () => {
    db.available = false;
    expect((await fetch(`${base}/api/projects`)).status).toBe(501);
  });
});
