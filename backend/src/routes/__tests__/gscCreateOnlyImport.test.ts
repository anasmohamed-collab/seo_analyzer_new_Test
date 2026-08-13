/**
 * End-to-end regression tests for the create-only GSC import.
 *
 * These drive the real apply loop (lib/gscSyncApply.ts) against the real
 * projects router over HTTP, with the fake pg pool underneath. The guarantee
 * being protected — "importing GSC properties never modifies an existing
 * project" — is a property of the client and the route together, so testing
 * either alone would not prove it.
 *
 * Nothing here contacts Google, Smacient, or any real deployment.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { createFakeSitesDb } from './fakeSitesDb.js';

const db = createFakeSitesDb();

vi.mock('../../lib/db.js', () => ({
  getDb: () => (db.available ? { query: db.query } : null),
}));

const { projectsRouter } = await import('../projects.js');
const {
  collectGscProperties,
  compareInventories,
  parseProperties,
  planSync,
} = await import('../../lib/gscSync.js');
const { applyPlan, fetchInventory } = await import('../../lib/gscSyncApply.js');
const { buildCoverage } = await import('../../lib/gscSyncCli.js');

type LiveCheck = import('../../lib/gscSync.js').LiveCheck;
type PlanEntry = import('../../lib/gscSync.js').PlanEntry;
type SyncPlan = import('../../lib/gscSync.js').SyncPlan;

// ── test server ───────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/api', projectsRouter);
const server = app.listen(0);
const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// ── fixture ───────────────────────────────────────────────────────

const liveOk = (hostname: string, siteName = '', status = 200): LiveCheck => ({
  ok: true, status, finalUrl: `https://${hostname}/`, finalHostname: hostname,
  finalProtocol: 'https', siteName,
});

const LIVE: Record<string, LiveCheck> = {
  'kuwaittimes.com': liveOk('kuwaittimes.com', 'Kuwait Times'),
  'manilatimes.net': liveOk('www.manilatimes.net', 'The Manila Times'),
  'akhbaar24.com': liveOk('www.akhbaar24.com', 'Akhbaar24'),
  'sports.lematin.ma': liveOk('sports.lematin.ma', 'Le Matin Sports'),
  'lematin.ma': liveOk('lematin.ma', 'Le Matin'),
  'beta.example.com': liveOk('beta.example.com'),
  'raya.com': { ok: false, error: 'fetch failed' },
  'alroeya.com': liveOk('cnnbusinessarabic.com'),
};

/** Two captured `gsc_list_sites` pages covering every reportable category. */
const CAPTURED_PAGES = {
  pages: [
    {
      sites: [
        { site_url: 'sc-domain:kuwaittimes.com', permission_level: 'siteOwner' },
        { site_url: 'sc-domain:manilatimes.net', permission_level: 'siteOwner' },
        { site_url: 'https://www.manilatimes.net/', permission_level: 'siteFullUser' },
        { site_url: 'https://manilatimes.net/', permission_level: 'siteFullUser' },
      ],
      next_page_token: 'page-2',
    },
    {
      sites: [
        { site_url: 'https://akhbaar24.com/', permission_level: 'siteOwner' },
        { site_url: 'https://www.akhbaar24.com/', permission_level: 'siteOwner' },
        { site_url: 'https://lematin.ma/', permission_level: 'siteOwner' },
        { site_url: 'https://sports.lematin.ma/', permission_level: 'siteOwner' },
        { site_url: 'sc-domain:beta.example.com', permission_level: 'siteOwner' },
        { site_url: 'sc-domain:raya.com', permission_level: 'siteRestrictedUser' },
        { site_url: 'sc-domain:alroeya.com', permission_level: 'siteOwner' },
        { site_url: 'javascript:alert(1)', permission_level: 'siteOwner' },
      ],
    },
  ],
};

async function buildPlan(): Promise<{ plan: SyncPlan; unparsable: string[] }> {
  const collected = collectGscProperties(CAPTURED_PAGES);
  const { properties, unparsable } = parseProperties(collected.sites);
  const existingProjects = await fetchInventory(apiBase);
  const plan = planSync({ properties, unparsable, existingProjects, liveChecks: LIVE });
  return { plan, unparsable };
}

/** A pre-existing, hand-curated project the import must never touch. */
function seedKuwaitTimes() {
  return db.seed({
    domain: 'kuwaittimes.com',
    project_name: 'Kuwait Times Newspaper',
    website_url: 'https://kuwaittimes.com/',
    is_beta: true,
    last_form_values: {
      homeUrl: 'https://kuwaittimes.com/',
      articleUrl: 'https://kuwaittimes.com/a-real-story',
    },
    last_audit_at: '2026-02-01T00:00:00.000Z',
  });
}

function writeStatements(): string[] {
  return db.executedSql.filter((s) => /INSERT INTO|UPDATE |DELETE FROM/i.test(s));
}

beforeEach(() => {
  db.reset();
});

// ── dry run ───────────────────────────────────────────────────────

describe('create-only dry run', () => {
  it('performs zero writes while producing a complete plan', async () => {
    seedKuwaitTimes();
    const before = db.snapshot();
    db.executedSql.length = 0;

    const collected = collectGscProperties(CAPTURED_PAGES);
    const { plan, unparsable } = await buildPlan();
    const coverage = buildCoverage(collected, plan, unparsable);

    expect(plan.create.length).toBeGreaterThan(0);
    expect(coverage.complete).toBe(true);
    expect(writeStatements()).toEqual([]);
    expect(db.snapshot()).toEqual(before);
  });

  it('categorizes every collected property exactly once', async () => {
    seedKuwaitTimes();
    const collected = collectGscProperties(CAPTURED_PAGES);
    const { plan, unparsable } = await buildPlan();
    const coverage = buildCoverage(collected, plan, unparsable);

    expect(collected.rawPropertyCount).toBe(12);
    expect(collected.exactDuplicateCount).toBe(0);
    expect(collected.uniquePropertyCount).toBe(12);
    expect(coverage.accountedProperties).toBe(12);
    expect(coverage.complete).toBe(true);
  });
});

// ── canonical identity ────────────────────────────────────────────

describe('canonical identity', () => {
  it('collapses www, non-www and sc-domain properties into one created project', async () => {
    const { plan } = await buildPlan();
    const manila = plan.create.filter((e) => e.domain === 'manilatimes.net');

    expect(manila).toHaveLength(1);
    expect(manila[0].gscProperties.sort()).toEqual([
      'https://manilatimes.net/', 'https://www.manilatimes.net/', 'sc-domain:manilatimes.net',
    ]);

    await applyPlan(apiBase, plan.create, { createOnly: true });
    expect(db.sites.filter((s) => s.domain === 'manilatimes.net')).toHaveLength(1);
  });

  it('keeps a meaningful subdomain as its own project', async () => {
    const { plan } = await buildPlan();
    const domains = plan.create.map((e) => e.domain).sort();

    expect(domains).toContain('lematin.ma');
    expect(domains).toContain('sports.lematin.ma');

    await applyPlan(apiBase, plan.create, { createOnly: true });
    expect(db.sites.map((s) => s.domain)).toContain('lematin.ma');
    expect(db.sites.map((s) => s.domain)).toContain('sports.lematin.ma');
  });
});

// ── apply ─────────────────────────────────────────────────────────

describe('create-only apply', () => {
  it('sends exactly the planned creations and nothing else', async () => {
    seedKuwaitTimes();
    const { plan } = await buildPlan();
    db.executedSql.length = 0;

    const outcome = await applyPlan(apiBase, plan.create, { createOnly: true });

    expect(outcome.halted).toBeNull();
    expect(outcome.created).toBe(plan.create.length);
    expect(outcome.updated).toBe(0);
    expect(outcome.conflicts).toBe(0);
    expect(outcome.failed).toBe(0);

    const writes = writeStatements();
    expect(writes).toHaveLength(plan.create.length);
    expect(writes.every((s) => /DO NOTHING/i.test(s))).toBe(true);
    expect(writes.some((s) => /DO UPDATE/i.test(s))).toBe(false);
  });

  it('never writes a proposed update', async () => {
    // A stored website_url the planner would like to correct.
    const stale = db.seed({
      domain: 'akhbaar24.com',
      project_name: 'Akhbaar24',
      website_url: 'http://akhbaar24.com',
    });
    const before = db.snapshot();

    const { plan } = await buildPlan();
    expect(plan.update.map((e) => e.domain)).toContain('akhbaar24.com');

    const outcome = await applyPlan(apiBase, plan.create, { createOnly: true });
    expect(outcome.halted).toBeNull();

    const after = db.sites.find((s) => s.id === stale.id)!;
    expect(after).toEqual(before.find((s) => s.id === stale.id));
    expect(after.website_url).toBe('http://akhbaar24.com');
  });

  it('refuses to send a proposed update even if one is passed in', async () => {
    db.seed({ domain: 'akhbaar24.com', project_name: 'Akhbaar24', website_url: 'http://akhbaar24.com' });
    const { plan } = await buildPlan();
    const before = db.snapshot();
    db.executedSql.length = 0;

    const outcome = await applyPlan(apiBase, plan.update, { createOnly: true });

    expect(outcome.failed).toBe(1);
    expect(outcome.halted).toMatch(/only "create" entries may be applied/);
    expect(writeStatements()).toEqual([]);
    expect(db.snapshot()).toEqual(before);
  });

  it('leaves every pre-existing project byte-for-byte unchanged', async () => {
    const kuwait = seedKuwaitTimes();
    const inventoryBefore = await fetchInventory(apiBase);
    const rowBefore = db.snapshot().find((s) => s.id === kuwait.id)!;

    const { plan } = await buildPlan();
    await applyPlan(apiBase, plan.create, { createOnly: true });

    const inventoryAfter = await fetchInventory(apiBase);
    const comparison = compareInventories(inventoryBefore, inventoryAfter);

    expect(comparison.preserved).toBe(true);
    expect(comparison.changed).toEqual([]);
    expect(comparison.missingIds).toEqual([]);
    expect(comparison.unchangedIds).toEqual([kuwait.id]);
    expect(comparison.addedIds).toHaveLength(plan.create.length);
    expect(db.snapshot().find((s) => s.id === kuwait.id)).toEqual(rowBefore);
  });

  it('creates projects that are not automation-ready and carry no audit state', async () => {
    const { plan } = await buildPlan();
    await applyPlan(apiBase, plan.create, { createOnly: true });

    const inventory = await fetchInventory(apiBase);
    for (const project of inventory) {
      expect(project.last_form_values).toBeNull();
      expect(project.automation_ready).toBe(false);
      expect(project.audit_count).toBe(0);
      expect(project.completed_count).toBe(0);
      expect(project.last_audit_at).toBeNull();
      expect(project.is_beta).toBe(false);
    }
  });

  it('triggers no audit and touches no notification state', async () => {
    seedKuwaitTimes();
    const { plan } = await buildPlan();
    db.executedSql.length = 0;

    await applyPlan(apiBase, plan.create, { createOnly: true });

    const touched = db.executedSql.join('\n');
    expect(touched).not.toMatch(/audit_runs/i);
    expect(touched).not.toMatch(/audit_results/i);
    expect(touched).not.toMatch(/notification/i);
    expect(touched).not.toMatch(/DELETE FROM/i);
    expect(touched).not.toMatch(/last_form_values/i);
  });

  it('is idempotent — a second apply conflicts and changes nothing', async () => {
    const { plan } = await buildPlan();
    const first = await applyPlan(apiBase, plan.create, { createOnly: true });
    expect(first.created).toBe(plan.create.length);

    const afterFirst = db.snapshot();
    const inventoryAfterFirst = await fetchInventory(apiBase);

    const second = await applyPlan(apiBase, plan.create, { createOnly: true });
    expect(second.created).toBe(0);
    expect(second.conflicts).toBe(1);
    expect(second.halted).toMatch(/already exists and was left untouched/);

    expect(db.snapshot()).toEqual(afterFirst);
    expect(compareInventories(inventoryAfterFirst, await fetchInventory(apiBase)).preserved).toBe(true);
  });

  it('halts on the first conflict without attempting the remaining writes', async () => {
    const { plan } = await buildPlan();
    expect(plan.create.length).toBeGreaterThan(2);

    // The first planned creation already exists.
    db.seed({ domain: plan.create[0].domain, project_name: 'Pre-existing' });

    const outcome = await applyPlan(apiBase, plan.create, { createOnly: true });

    expect(outcome.attempted).toBe(1);
    expect(outcome.conflicts).toBe(1);
    expect(outcome.created).toBe(0);
    expect(db.sites).toHaveLength(1);
  });
});

// ── the race the create-only contract exists for ──────────────────

describe('a project that appears between planning and the write', () => {
  it('conflicts and mutates nothing', async () => {
    const { plan } = await buildPlan();
    const target = plan.create.find((e) => e.domain === 'manilatimes.net')!;

    // Someone else creates the project after the plan was made, with their own
    // name, URL, classification and audit configuration.
    const raced = db.seed({
      domain: 'manilatimes.net',
      project_name: 'Created By Someone Else',
      website_url: 'https://manilatimes.net/custom',
      is_beta: true,
      last_form_values: {
        homeUrl: 'https://manilatimes.net/',
        articleUrl: 'https://manilatimes.net/their-story',
      },
    });
    const before = db.snapshot();
    const inventoryBefore = await fetchInventory(apiBase);

    const outcome = await applyPlan(apiBase, [target], { createOnly: true });

    expect(outcome.conflicts).toBe(1);
    expect(outcome.created).toBe(0);
    expect(outcome.updated).toBe(0);
    expect(outcome.results[0]).toMatchObject({ httpStatus: 409, conflict: true, projectId: raced.id });

    expect(db.snapshot()).toEqual(before);
    expect(compareInventories(inventoryBefore, await fetchInventory(apiBase)).preserved).toBe(true);
  });

  it('would have silently updated the project under the legacy upsert path', async () => {
    // Documents exactly what create-only prevents: the same race, applied
    // through the legacy contract, rewrites the other party's project.
    const { plan } = await buildPlan();
    const target = plan.create.find((e) => e.domain === 'manilatimes.net')!;

    db.seed({
      domain: 'manilatimes.net',
      project_name: 'Created By Someone Else',
      website_url: 'https://manilatimes.net/custom',
    });

    const outcome = await applyPlan(apiBase, [target], { createOnly: false });

    expect(outcome.conflicts).toBe(1);
    expect(db.sites[0].project_name).toBe('The Manila Times');
    expect(db.sites[0].website_url).toBe('https://www.manilatimes.net/');
  });
});

// ── properties that must never be created automatically ───────────

describe('properties held back from automatic creation', () => {
  it('reports non-production, ambiguous and unparsable properties without creating them', async () => {
    const { plan, unparsable } = await buildPlan();

    expect(plan.nonProduction.map((e) => e.domain)).toContain('beta.example.com');
    expect(plan.ambiguous.map((e) => e.domain).sort()).toEqual(['alroeya.com', 'raya.com']);
    expect(unparsable).toEqual(['javascript:alert(1)']);

    const created = plan.create.map((e: PlanEntry) => e.domain);
    expect(created).not.toContain('beta.example.com');
    expect(created).not.toContain('raya.com');
    expect(created).not.toContain('alroeya.com');

    await applyPlan(apiBase, plan.create, { createOnly: true });
    const domains = db.sites.map((s) => s.domain);
    expect(domains).not.toContain('beta.example.com');
    expect(domains).not.toContain('raya.com');
    expect(domains).not.toContain('alroeya.com');
  });

  it('gives a reason for every held-back property', async () => {
    const { plan } = await buildPlan();
    for (const entry of [...plan.nonProduction, ...plan.ambiguous]) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.proposedWebsiteUrl).toBeNull();
    }
    expect(plan.ambiguous.find((e) => e.domain === 'alroeya.com')!.redirectDrift)
      .toEqual({ from: 'alroeya.com', to: 'cnnbusinessarabic.com' });
  });

  it('never sets is_beta from a hostname that merely looks non-production', async () => {
    const { plan } = await buildPlan();
    await applyPlan(apiBase, plan.create, { createOnly: true });
    expect(db.sites.every((s) => s.is_beta === false)).toBe(true);
  });
});
