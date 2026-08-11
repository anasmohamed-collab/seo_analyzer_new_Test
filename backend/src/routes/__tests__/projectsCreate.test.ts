/**
 * Route-level tests for POST /api/projects and the GET /api/projects ordering.
 *
 * The pg pool is replaced by a small fake that emulates the documented upsert
 * semantics of the statement in projects.ts (ON CONFLICT (domain) DO UPDATE,
 * COALESCE on last_form_values, `xmax = 0` as the created flag). The fake lets
 * us assert the HTTP contract without a live database; the SQL text itself is
 * asserted separately so the fake cannot drift from the real statement.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

// ── Fake pg pool ──────────────────────────────────────────────────

interface SiteRow {
  id: string;
  domain: string;
  project_name: string | null;
  website_url: string | null;
  is_beta: boolean;
  last_form_values: Record<string, string> | null;
  created_at: string;
  last_audit_at: string | null;
}

const sites: SiteRow[] = [];
const executedSql: string[] = [];
let nextId = 1;

function fakeQuery(sql: string, params: unknown[] = []) {
  executedSql.push(sql);

  if (/SELECT id, domain FROM sites WHERE id/i.test(sql)) {
    const row = sites.find((s) => s.id === String(params[0]));
    return Promise.resolve({ rows: row ? [{ id: row.id, domain: row.domain }] : [] });
  }

  if (/UPDATE sites[\s\S]*SET last_form_values/i.test(sql)) {
    const [formValues, id] = params as [string, string];
    const row = sites.find((s) => s.id === id);
    if (!row) return Promise.resolve({ rows: [] });
    row.last_form_values = JSON.parse(formValues);
    return Promise.resolve({ rows: [{ ...row }] });
  }

  if (/INSERT INTO sites/i.test(sql)) {
    const [domain, projectName, websiteUrl, formValues, isBeta] = params as [
      string,
      string,
      string,
      string | null,
      boolean | null,
    ];
    const existing = sites.find((s) => s.domain === domain);

    if (existing) {
      existing.project_name = projectName;
      existing.website_url = websiteUrl;
      // COALESCE(EXCLUDED.last_form_values, sites.last_form_values)
      if (formValues !== null) existing.last_form_values = JSON.parse(formValues);
      // Omission preserves the existing classification.
      if (isBeta !== null) existing.is_beta = isBeta;
      return Promise.resolve({ rows: [{ ...existing, created: false }] });
    }

    const row: SiteRow = {
      id: `site-${nextId++}`,
      domain,
      project_name: projectName,
      website_url: websiteUrl,
      is_beta: isBeta ?? false,
      last_form_values: formValues === null ? null : JSON.parse(formValues),
      created_at: new Date().toISOString(),
      last_audit_at: null,
    };
    sites.push(row);
    return Promise.resolve({ rows: [{ ...row, created: true }] });
  }

  if (/^\s*UPDATE sites/i.test(sql)) {
    const [projectName, isBeta, id] = params as [string | null, boolean | null, string];
    const existing = sites.find((s) => s.id === id);
    if (!existing) return Promise.resolve({ rows: [] });
    if (projectName !== null) existing.project_name = projectName;
    if (isBeta !== null) existing.is_beta = isBeta;
    return Promise.resolve({ rows: [{ ...existing }] });
  }

  if (/FROM sites s/i.test(sql)) {
    return Promise.resolve({
      rows: sites.map((s) => ({ ...s, audit_count: 0, completed_count: 0 })),
    });
  }

  return Promise.resolve({ rows: [] });
}

let dbAvailable = true;

vi.mock('../../lib/db.js', () => ({
  getDb: () => (dbAvailable ? { query: fakeQuery } : null),
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
  sites.length = 0;
  executedSql.length = 0;
  nextId = 1;
  dbAvailable = true;
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

describe('no database configured', () => {
  it('returns 501 from POST /api/projects', async () => {
    dbAvailable = false;
    const res = await postProject({ website_url: 'https://example.com' });

    expect(res.status).toBe(501);
    expect((await json<ErrorResponse>(res)).error).toContain('Database required');
  });

  it('returns 501 from GET /api/projects', async () => {
    dbAvailable = false;
    expect((await fetch(`${base}/api/projects`)).status).toBe(501);
  });
});
