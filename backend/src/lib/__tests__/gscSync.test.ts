import { describe, it, expect } from 'vitest';
import {
  buildUpsertBody,
  deriveProjectName,
  groupByCanonicalDomain,
  isUnusableProjectName,
  nextPageToken,
  nonProductionMarkers,
  parseProperties,
  parseProperty,
  planSync,
  readSmacientSites,
  selectProductionUrl,
  type ExistingProject,
  type LiveCheck,
  type SmacientSite,
} from '../gscSync.js';

// ── helpers ───────────────────────────────────────────────────────

const site = (site_url: string, permission_level = 'siteFullUser'): SmacientSite => ({
  site_url,
  permission_level,
});

const liveOk = (hostname: string, siteName = '', status = 200): LiveCheck => ({
  ok: true,
  status,
  finalUrl: `https://${hostname}/`,
  finalHostname: hostname,
  finalProtocol: 'https',
  siteName,
});

const props = (...urls: string[]) => parseProperties(urls.map((u) => site(u))).properties;

// ── reading the Smacient response ─────────────────────────────────

describe('readSmacientSites', () => {
  it('reads a single gsc_list_sites page', () => {
    const out = readSmacientSites({ sites: [site('sc-domain:a.com'), site('https://b.com/')] });
    expect(out.map((s) => s.site_url)).toEqual(['sc-domain:a.com', 'https://b.com/']);
  });

  it('reads a bare array of sites', () => {
    expect(readSmacientSites([site('sc-domain:a.com')])).toHaveLength(1);
  });

  it('flattens paginated pages and de-duplicates repeated properties', () => {
    const out = readSmacientSites({
      pages: [
        { sites: [site('sc-domain:a.com'), site('https://b.com/')] },
        { sites: [site('https://b.com/'), site('https://c.com/')] },
      ],
    });
    expect(out.map((s) => s.site_url)).toEqual(['sc-domain:a.com', 'https://b.com/', 'https://c.com/']);
  });

  it('returns an empty list for an empty or malformed payload instead of throwing', () => {
    expect(readSmacientSites(null)).toEqual([]);
    expect(readSmacientSites({})).toEqual([]);
    expect(readSmacientSites({ sites: null })).toEqual([]);
  });

  it('skips entries with no usable site_url', () => {
    const out = readSmacientSites({
      sites: [site('sc-domain:a.com'), { site_url: '' }, { site_url: '   ' }],
    });
    expect(out).toHaveLength(1);
  });

  it('exposes a pagination token when the page carries one', () => {
    expect(nextPageToken({ sites: [], next_page_token: 'abc' })).toBe('abc');
    expect(nextPageToken({ sites: [] })).toBeNull();
    expect(nextPageToken({ sites: [], next_page_token: '' })).toBeNull();
  });
});

// ── parsing properties ────────────────────────────────────────────

describe('parseProperty', () => {
  it('parses a domain property and reports no protocol', () => {
    const p = parseProperty(site('sc-domain:alkhaleej.ae'))!;
    expect(p.propertyType).toBe('DOMAIN_PROPERTY');
    expect(p.hostname).toBe('alkhaleej.ae');
    expect(p.protocol).toBeNull();
    expect(p.normalizedDomain).toBe('alkhaleej.ae');
    expect(p.permissionLevel).toBe('siteFullUser');
  });

  it('parses a URL-prefix property with protocol and www flag', () => {
    const p = parseProperty(site('https://www.akhbaar24.com/'))!;
    expect(p.propertyType).toBe('URL_PREFIX_PROPERTY');
    expect(p.hostname).toBe('www.akhbaar24.com');
    expect(p.protocol).toBe('https');
    expect(p.usesWww).toBe(true);
    expect(p.normalizedDomain).toBe('akhbaar24.com');
  });

  it('normalizes protocol, path, query, port and trailing dot away from the key', () => {
    expect(parseProperty(site('http://Example.com:8080/news?a=1#x'))!.normalizedDomain).toBe('example.com:8080');
    expect(parseProperty(site('https://example.com./'))!.normalizedDomain).toBe('example.com');
    expect(parseProperty(site('https://example.com/deep/path/'))!.normalizedDomain).toBe('example.com');
  });

  it('treats www and non-www spellings as the same normalized domain', () => {
    expect(parseProperty(site('https://www.gulftoday.ae/'))!.normalizedDomain).toBe('gulftoday.ae');
    expect(parseProperty(site('https://gulftoday.ae/'))!.normalizedDomain).toBe('gulftoday.ae');
    expect(parseProperty(site('sc-domain:gulftoday.ae'))!.normalizedDomain).toBe('gulftoday.ae');
  });

  it('keeps non-www subdomains as their own website', () => {
    expect(parseProperty(site('https://sports.lematin.ma/'))!.normalizedDomain).toBe('sports.lematin.ma');
    expect(parseProperty(site('sc-domain:premium.sinarharian.com.my'))!.normalizedDomain)
      .toBe('premium.sinarharian.com.my');
  });

  it('rejects unusable property values', () => {
    expect(parseProperty(site(''))).toBeNull();
    expect(parseProperty(site('sc-domain:'))).toBeNull();
    expect(parseProperty(site('javascript:alert(1)'))).toBeNull();
  });

  it('reports unparsable properties instead of silently dropping them', () => {
    const result = parseProperties([site('sc-domain:ok.com'), site('javascript:alert(1)')]);
    expect(result.properties).toHaveLength(1);
    expect(result.unparsable).toEqual(['javascript:alert(1)']);
  });
});

// ── environment classification ────────────────────────────────────

describe('nonProductionMarkers', () => {
  it.each([
    ['beta.al-madina.com', 'beta'],
    ['next.gulf-times.com', 'next'],
    ['new.al-madina.com', 'new'],
    ['staging.example.com', 'staging'],
    ['dev.example.com', 'dev'],
    ['preview.example.com', 'preview'],
    ['demo.example.com', 'demo'],
    ['test.example.com', 'test'],
  ])('flags %s', (host, marker) => {
    expect(nonProductionMarkers(host)).toContain(marker);
  });

  it('flags localhost', () => {
    expect(nonProductionMarkers('localhost')).toContain('localhost');
  });

  it.each([
    'thehimalayantimes.com',
    'newtimes.co.rw',
    'manilatimes.net',
    'arabtimesonline.com',
    'sinardaily.my',
  ])('does not flag the production site %s', (host) => {
    expect(nonProductionMarkers(host)).toEqual([]);
  });
});

// ── grouping and production URL selection ─────────────────────────

describe('groupByCanonicalDomain', () => {
  it('collapses a domain property and both www spellings into one website', () => {
    const groups = groupByCanonicalDomain(
      props('sc-domain:akhbaar24.com', 'https://akhbaar24.com/', 'https://www.akhbaar24.com/'),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].domain).toBe('akhbaar24.com');
    expect(groups[0].members).toHaveLength(3);
    expect(groups[0].hasDomainProperty).toBe(true);
    expect(groups[0].hasUrlPrefixProperty).toBe(true);
    // a www URL-prefix decides the host to probe
    expect(groups[0].candidateHost).toBe('www.akhbaar24.com');
  });

  it('does not merge a subdomain into its parent', () => {
    const groups = groupByCanonicalDomain(props('https://lematin.ma/', 'https://sports.lematin.ma/'));
    expect(groups.map((g) => g.domain).sort()).toEqual(['lematin.ma', 'sports.lematin.ma']);
  });

  it('falls back to the root host when only a domain property exists', () => {
    const groups = groupByCanonicalDomain(props('sc-domain:alkhaleej.ae'));
    expect(groups[0].candidateHost).toBe('alkhaleej.ae');
  });
});

describe('selectProductionUrl', () => {
  it('uses the live redirect target and always emits https with a trailing slash', () => {
    const [group] = groupByCanonicalDomain(props('sc-domain:alkhaleej.ae'));
    const d = selectProductionUrl(group, liveOk('www.alkhaleej.ae'));
    expect(d.websiteUrl).toBe('https://www.alkhaleej.ae/');
    expect(d.confidence).toBe('high');
  });

  it('upgrades an http-only property to https', () => {
    const [group] = groupByCanonicalDomain(props('http://elmundo.sv/'));
    const d = selectProductionUrl(group, { ...liveOk('elmundo.sv'), finalProtocol: 'http' });
    expect(d.websiteUrl).toBe('https://elmundo.sv/');
  });

  it('accepts a bot-protected response when a URL-prefix property declares the same host', () => {
    const [group] = groupByCanonicalDomain(props('https://lematin.ma/', 'sc-domain:lematin.ma'));
    const d = selectProductionUrl(group, liveOk('lematin.ma', '', 403));
    expect(d.confidence).toBe('high');
    expect(d.websiteUrl).toBe('https://lematin.ma/');
  });

  it('downgrades a bot-protected response with no corroborating URL-prefix to medium', () => {
    const [group] = groupByCanonicalDomain(props('sc-domain:jordantimes.com'));
    expect(selectProductionUrl(group, liveOk('jordantimes.com', '', 403)).confidence).toBe('medium');
  });

  it('flags a property that redirects to a different domain', () => {
    const [group] = groupByCanonicalDomain(props('sc-domain:alroeya.com'));
    const d = selectProductionUrl(group, liveOk('cnnbusinessarabic.com'));
    expect(d.confidence).toBe('low');
    expect(d.redirectDrift).toEqual({ from: 'alroeya.com', to: 'cnnbusinessarabic.com' });
  });

  it('is low confidence when the live check failed or was not run', () => {
    const [group] = groupByCanonicalDomain(props('sc-domain:raya.com'));
    expect(selectProductionUrl(group, { ok: false, error: 'fetch failed' }).confidence).toBe('low');
    expect(selectProductionUrl(group, undefined).confidence).toBe('low');
  });
});

// ── naming ────────────────────────────────────────────────────────

describe('project naming', () => {
  it('treats empty names and raw URLs as unusable', () => {
    expect(isUnusableProjectName(null)).toBe(true);
    expect(isUnusableProjectName('   ')).toBe(true);
    expect(isUnusableProjectName('https://next.al-madina.com/')).toBe(true);
    expect(isUnusableProjectName('The Manila Times')).toBe(false);
  });

  it('prefers a publication name and falls back to the domain', () => {
    expect(deriveProjectName('manilatimes.net', 'The Manila Times')).toBe('The Manila Times');
    expect(deriveProjectName('akhbaar24.com', '')).toBe('akhbaar24.com');
    expect(deriveProjectName('akhbaar24.com', 'https://akhbaar24.com/')).toBe('akhbaar24.com');
    expect(deriveProjectName('a.com', 'x')).toBe('a.com');
  });

  it('never uses a full URL as the project name', () => {
    const plan = planSync({
      properties: props('sc-domain:akhbaar24.com'),
      existingProjects: [],
      liveChecks: { 'akhbaar24.com': liveOk('www.akhbaar24.com', 'https://www.akhbaar24.com/') },
    });
    expect(plan.create[0].proposedProjectName).toBe('akhbaar24.com');
  });
});

// ── planning ──────────────────────────────────────────────────────

describe('planSync', () => {
  const existing: ExistingProject[] = [
    {
      id: 'p-kuwait',
      domain: 'kuwaittimes.com',
      project_name: 'Kuwait Times Newspaper',
      website_url: 'https://kuwaittimes.com/',
      audit_count: 1,
    },
  ];

  it('plans creation for a live property missing from the database', () => {
    const plan = planSync({
      properties: props('sc-domain:manilatimes.net'),
      existingProjects: existing,
      liveChecks: { 'manilatimes.net': liveOk('www.manilatimes.net', 'The Manila Times') },
    });
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]).toMatchObject({
      action: 'create',
      domain: 'manilatimes.net',
      proposedWebsiteUrl: 'https://www.manilatimes.net/',
      proposedProjectName: 'The Manila Times',
      existingProjectId: null,
    });
    expect(plan.totals.expectedProjectsAfterApply).toBe(existing.length + 1);
  });

  it('matches an existing project and leaves a correct one unchanged', () => {
    const plan = planSync({
      properties: props('sc-domain:kuwaittimes.com', 'https://kuwaittimes.com/'),
      existingProjects: existing,
      liveChecks: { 'kuwaittimes.com': liveOk('kuwaittimes.com', 'Kuwait Times') },
    });
    expect(plan.create).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
    expect(plan.unchanged).toHaveLength(1);
    expect(plan.unchanged[0].existingProjectId).toBe('p-kuwait');
  });

  it('plans a website_url correction with exact before/after values', () => {
    const plan = planSync({
      properties: props('sc-domain:akhbaar24.com'),
      existingProjects: [{ id: 'p-akhbaar', domain: 'akhbaar24.com', project_name: 'Akhbaar24', website_url: null }],
      liveChecks: { 'akhbaar24.com': liveOk('www.akhbaar24.com', 'Akhbaar24') },
    });
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0].changes).toEqual([
      { field: 'website_url', before: null, after: 'https://www.akhbaar24.com/' },
    ]);
  });

  it('replaces an unusable name and preserves a good one', () => {
    const plan = planSync({
      properties: props('sc-domain:a.com', 'sc-domain:b.com'),
      existingProjects: [
        { id: 'p-a', domain: 'a.com', project_name: 'https://a.com/', website_url: 'https://a.com/' },
        { id: 'p-b', domain: 'b.com', project_name: 'Real Name', website_url: null },
      ],
      liveChecks: { 'a.com': liveOk('a.com', 'Alpha News'), 'b.com': liveOk('b.com', 'Ignored') },
    });
    const a = plan.update.find((e) => e.domain === 'a.com')!;
    expect(a.changes).toContainEqual({ field: 'project_name', before: 'https://a.com/', after: 'Alpha News' });

    // b.com only needs a URL, and its good name must survive the upsert.
    const b = plan.update.find((e) => e.domain === 'b.com')!;
    expect(b.changes.map((c) => c.field)).toEqual(['website_url']);
    expect(b.proposedProjectName).toBe('Real Name');
  });

  it('classifies non-production hostnames instead of creating them', () => {
    const plan = planSync({
      properties: props('sc-domain:beta.example.com', 'sc-domain:next.example.com'),
      existingProjects: [],
      liveChecks: {
        'beta.example.com': liveOk('beta.example.com'),
        'next.example.com': liveOk('next.example.com'),
      },
    });
    expect(plan.create).toHaveLength(0);
    expect(plan.nonProduction).toHaveLength(2);
    expect(plan.nonProduction.every((e) => e.proposedWebsiteUrl === null)).toBe(true);
  });

  it('retains database projects that are absent from GSC and never plans deletion', () => {
    const plan = planSync({
      properties: props('sc-domain:manilatimes.net'),
      existingProjects: [{ id: 'p-orphan', domain: 'orphan.com', project_name: 'Orphan', audit_count: 9 }],
      liveChecks: { 'manilatimes.net': liveOk('www.manilatimes.net', 'The Manila Times') },
    });
    expect(plan.notInGsc).toHaveLength(1);
    expect(plan.notInGsc[0].existingProjectId).toBe('p-orphan');
    const actions = Object.values(plan).flatMap((v) => (Array.isArray(v) ? v : []))
      .map((e) => (e as { action?: string }).action).filter(Boolean);
    expect(actions).not.toContain('delete');
    expect(actions).not.toContain('merge');
  });

  it('routes ambiguous properties to manual review rather than creating them', () => {
    const plan = planSync({
      properties: props('sc-domain:alroeya.com', 'sc-domain:raya.com'),
      existingProjects: [],
      liveChecks: {
        'alroeya.com': liveOk('cnnbusinessarabic.com'),
        'raya.com': { ok: false, error: 'fetch failed' },
      },
    });
    expect(plan.create).toHaveLength(0);
    expect(plan.ambiguous).toHaveLength(2);
  });

  it('reports duplicate database rows without merging them', () => {
    const plan = planSync({
      properties: props('sc-domain:dup.com'),
      existingProjects: [
        { id: 'p-1', domain: 'dup.com', project_name: 'Dup', website_url: 'https://dup.com/', audit_count: 3 },
        { id: 'p-2', domain: 'www.dup.com', project_name: 'Dup 2', website_url: 'https://dup.com/', audit_count: 0 },
      ],
      liveChecks: { 'dup.com': liveOk('dup.com', 'Dup') },
    });
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0].rows.map((r) => r.id).sort()).toEqual(['p-1', 'p-2']);
    // one canonical website must never yield two creations
    expect(plan.create).toHaveLength(0);
  });

  it('never creates two projects for one canonical website', () => {
    const plan = planSync({
      properties: props('sc-domain:akhbaar24.com', 'https://akhbaar24.com/', 'https://www.akhbaar24.com/'),
      existingProjects: [],
      liveChecks: { 'akhbaar24.com': liveOk('www.akhbaar24.com', 'Akhbaar24') },
    });
    expect(plan.create).toHaveLength(1);
  });

  it('is idempotent: applying the plan and replanning yields no further work', () => {
    const properties = props('sc-domain:manilatimes.net', 'https://www.manilatimes.net/');
    const liveChecks = { 'manilatimes.net': liveOk('www.manilatimes.net', 'The Manila Times') };

    const first = planSync({ properties, existingProjects: [], liveChecks });
    expect(first.create).toHaveLength(1);

    // Simulate the apply step writing exactly what the plan proposed.
    const applied: ExistingProject[] = first.create.map((e, i) => ({
      id: `new-${i}`,
      domain: e.domain,
      project_name: e.proposedProjectName,
      website_url: e.proposedWebsiteUrl,
    }));

    const second = planSync({ properties, existingProjects: applied, liveChecks });
    expect(second.create).toHaveLength(0);
    expect(second.update).toHaveLength(0);
    expect(second.unchanged).toHaveLength(1);

    const third = planSync({ properties, existingProjects: applied, liveChecks });
    expect(third.totals).toEqual(second.totals);
  });

  it('handles an empty Smacient result without proposing any change', () => {
    const plan = planSync({ properties: [], existingProjects: existing, liveChecks: {} });
    expect(plan.create).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
    // the existing project is retained and merely reported as unmatched
    expect(plan.notInGsc).toHaveLength(1);
    expect(plan.totals.expectedProjectsAfterApply).toBe(existing.length);
  });

  it('carries partial Smacient failures through as an unparsable count', () => {
    const parsed = parseProperties([site('sc-domain:good.com'), site('not a url')]);
    const plan = planSync({
      properties: parsed.properties,
      unparsable: parsed.unparsable,
      existingProjects: [],
      liveChecks: { 'good.com': liveOk('good.com', 'Good') },
    });
    expect(plan.totals.unparsableProperties).toBe(1);
    expect(plan.totals.totalProperties).toBe(1);
  });

  it('does not mutate the inputs it is given', () => {
    const properties = props('sc-domain:manilatimes.net');
    const existingProjects: ExistingProject[] = [{ id: 'p', domain: 'x.com' }];
    const snapshot = JSON.stringify({ properties, existingProjects });
    planSync({ properties, existingProjects, liveChecks: { 'manilatimes.net': liveOk('www.manilatimes.net') } });
    expect(JSON.stringify({ properties, existingProjects })).toBe(snapshot);
  });
});

// ── apply-mode request shape ──────────────────────────────────────

describe('buildUpsertBody', () => {
  it('sends only project_name and website_url so audit configuration survives', () => {
    const plan = planSync({
      properties: props('sc-domain:manilatimes.net'),
      existingProjects: [],
      liveChecks: { 'manilatimes.net': liveOk('www.manilatimes.net', 'The Manila Times') },
    });
    const body = buildUpsertBody(plan.create[0]);
    expect(body).toEqual({
      project_name: 'The Manila Times',
      website_url: 'https://www.manilatimes.net/',
    });
    // homeUrl / articleUrl are absent, so last_form_values is preserved by the
    // route's COALESCE and no audit can be triggered by this request.
    expect(Object.keys(body).sort()).toEqual(['project_name', 'website_url']);
  });

  it('refuses to build a body for an entry with no resolved production URL', () => {
    const plan = planSync({
      properties: props('sc-domain:raya.com'),
      existingProjects: [],
      liveChecks: { 'raya.com': { ok: false, error: 'fetch failed' } },
    });
    expect(() => buildUpsertBody(plan.ambiguous[0])).toThrow(/not applyable/);
  });
});
