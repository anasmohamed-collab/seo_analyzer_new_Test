/**
 * Smacient GSC → SEO Analyzer synchronization planning.
 *
 * Pure logic only: no network, no filesystem, no database. Everything the
 * planner needs is passed in, so the whole decision surface is unit-testable
 * and a dry run is guaranteed to be side-effect free.
 *
 * The property list MUST come from the Smacient MCP `query-web-performance`
 * tool, action `gsc_list_sites`. This module never talks to Google directly
 * and never infers the property list from the database.
 *
 * Domain identity is delegated to normalizeProjectDomain so a project keyed
 * here is the same project the API would upsert.
 */

import { normalizeProjectDomain } from './normalizeProjectDomain.js';

// ── Smacient response shapes ──────────────────────────────────────

export interface SmacientSite {
  site_url: string;
  permission_level?: string | null;
}

/** One page of `gsc_list_sites`, or an already-collected array of pages. */
export type SmacientPayload =
  | SmacientSite[]
  | { sites?: SmacientSite[] | null; next_page_token?: string | null }
  | { pages?: SmacientPayload[] | null };

export type PropertyType = 'DOMAIN_PROPERTY' | 'URL_PREFIX_PROPERTY';

export interface ParsedProperty {
  originalProperty: string;
  propertyType: PropertyType;
  permissionLevel: string | null;
  hostname: string;
  /** null for `sc-domain:` properties — GSC states no protocol for them. */
  protocol: string | null;
  usesWww: boolean;
  normalizedDomain: string;
  nonProductionMarkers: string[];
}

/** Result of a bounded live homepage check, supplied by the caller. */
export interface LiveCheck {
  ok: boolean;
  status?: number;
  finalUrl?: string;
  finalHostname?: string;
  finalProtocol?: string;
  siteName?: string;
  error?: string;
}

export interface ExistingProject {
  id: string;
  domain: string;
  project_name?: string | null;
  website_url?: string | null;
  audit_count?: number;
}

// ── environment classification ────────────────────────────────────

/**
 * Hostname labels that mark a non-production environment. Matched as whole
 * dot-separated labels so `thehimalayantimes.com` is not caught by `test`
 * and `newtimes.co.rw` is not caught by `new`.
 */
export const NON_PRODUCTION_LABELS = [
  'beta', 'next', 'new', 'test', 'testing', 'staging', 'stage',
  'dev', 'development', 'preview', 'demo', 'sandbox', 'uat', 'qa',
] as const;

export function nonProductionMarkers(hostname: string): string[] {
  if (!hostname) return [];
  const host = hostname.toLowerCase();
  const found = new Set<string>();
  for (const label of host.split('.')) {
    if ((NON_PRODUCTION_LABELS as readonly string[]).includes(label)) found.add(label);
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('localhost:')) {
    found.add('localhost');
  }
  return [...found];
}

// ── reading the Smacient payload ──────────────────────────────────

/**
 * Flatten one page, an array of pages, or a `{pages:[…]}` envelope into a
 * single site list, de-duplicated by the exact property string.
 *
 * A page that carries no `sites` array yields nothing rather than throwing —
 * an empty GSC result is a valid state that must be verified, never a reason
 * to treat existing projects as removable.
 */
export function readSmacientSites(payload: SmacientPayload | null | undefined): SmacientSite[] {
  if (!payload) return [];

  const collected: SmacientSite[] = [];
  const visit = (node: SmacientPayload): void => {
    if (Array.isArray(node)) {
      for (const entry of node) {
        if (entry && typeof entry === 'object' && 'site_url' in entry) {
          collected.push(entry as SmacientSite);
        } else {
          visit(entry as SmacientPayload);
        }
      }
      return;
    }
    if (typeof node !== 'object') return;
    if ('pages' in node && Array.isArray(node.pages)) {
      for (const page of node.pages) visit(page);
      return;
    }
    if ('sites' in node && Array.isArray(node.sites)) collected.push(...node.sites);
  };
  visit(payload);

  const seen = new Set<string>();
  return collected.filter((s) => {
    if (!s || typeof s.site_url !== 'string' || !s.site_url.trim()) return false;
    const key = s.site_url.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The continuation token for the next `gsc_list_sites` call, if any. */
export function nextPageToken(payload: SmacientPayload | null | undefined): string | null {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') return null;
  const token = (payload as { next_page_token?: string | null }).next_page_token;
  return typeof token === 'string' && token.trim() ? token : null;
}

// ── parsing a single property ─────────────────────────────────────

const SC_DOMAIN_PREFIX = 'sc-domain:';

/** Parse one GSC property. Returns null when it is not usable at all. */
export function parseProperty(site: SmacientSite): ParsedProperty | null {
  const raw = typeof site?.site_url === 'string' ? site.site_url.trim() : '';
  if (!raw) return null;

  const permissionLevel = site.permission_level?.trim() ? site.permission_level.trim() : null;
  let hostname: string;
  let protocol: string | null;

  if (raw.toLowerCase().startsWith(SC_DOMAIN_PREFIX)) {
    // Domain properties cover every protocol and subdomain host, so GSC
    // states no scheme; strip the prefix and any stray path/port noise.
    const bare = raw.slice(SC_DOMAIN_PREFIX.length).trim();
    if (!bare) return null;
    const parsed = normalizeProjectDomain(`https://${bare}`);
    if (!parsed) return null;
    hostname = bare.toLowerCase().replace(/\/.*$/, '').replace(/\.$/, '').replace(/:\d+$/, '');
    protocol = null;
    return {
      originalProperty: raw,
      propertyType: 'DOMAIN_PROPERTY',
      permissionLevel,
      hostname,
      protocol,
      usesWww: hostname.startsWith('www.'),
      normalizedDomain: parsed,
      nonProductionMarkers: nonProductionMarkers(hostname),
    };
  }

  const normalized = normalizeProjectDomain(raw);
  if (!normalized) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  protocol = url.protocol.replace(':', '');

  return {
    originalProperty: raw,
    propertyType: 'URL_PREFIX_PROPERTY',
    permissionLevel,
    hostname,
    protocol,
    usesWww: hostname.startsWith('www.'),
    normalizedDomain: normalized,
    nonProductionMarkers: nonProductionMarkers(hostname),
  };
}

export interface ParsePropertiesResult {
  properties: ParsedProperty[];
  /** Properties Smacient returned that could not be parsed — never silently dropped. */
  unparsable: string[];
}

export function parseProperties(sites: SmacientSite[]): ParsePropertiesResult {
  const properties: ParsedProperty[] = [];
  const unparsable: string[] = [];
  for (const site of sites) {
    const parsed = parseProperty(site);
    if (parsed) properties.push(parsed);
    else if (site?.site_url) unparsable.push(String(site.site_url));
  }
  return { properties, unparsable };
}

// ── grouping into canonical websites ──────────────────────────────

export interface CanonicalSite {
  domain: string;
  members: ParsedProperty[];
  hasDomainProperty: boolean;
  hasUrlPrefixProperty: boolean;
  /** Host to probe: a www URL-prefix wins, then any URL-prefix, then the root. */
  candidateHost: string;
}

/**
 * Collapse properties onto one project per normalized domain.
 *
 * `www.` and non-`www.` spellings of the same root merge; every other
 * subdomain stays its own website, because `sports.lematin.ma` is a
 * different publication from `lematin.ma`.
 */
export function groupByCanonicalDomain(properties: ParsedProperty[]): CanonicalSite[] {
  const groups = new Map<string, ParsedProperty[]>();
  for (const p of properties) {
    const bucket = groups.get(p.normalizedDomain);
    if (bucket) bucket.push(p);
    else groups.set(p.normalizedDomain, [p]);
  }

  return [...groups.entries()].map(([domain, members]) => {
    const prefixes = members.filter((m) => m.propertyType === 'URL_PREFIX_PROPERTY');
    const wwwPrefix = prefixes.find((m) => m.usesWww);
    return {
      domain,
      members,
      hasDomainProperty: members.some((m) => m.propertyType === 'DOMAIN_PROPERTY'),
      hasUrlPrefixProperty: prefixes.length > 0,
      candidateHost: wwwPrefix?.hostname ?? prefixes[0]?.hostname ?? domain,
    };
  });
}

// ── production URL selection ──────────────────────────────────────

export type Confidence = 'high' | 'medium' | 'low';

export interface ProductionUrlDecision {
  websiteUrl: string;
  confidence: Confidence;
  reason: string;
  /** Set when the live check left the property's own domain entirely. */
  redirectDrift: { from: string; to: string } | null;
}

/**
 * Statuses that still complete the redirect chain. A bot-protected homepage
 * has already told us which host it canonicalizes to, so the hostname is
 * usable even though the body is not.
 */
const BOT_PROTECTED_STATUSES = [401, 403, 405, 406, 409, 429, 503];

/** Always https, always a trailing slash — the stored form must be stable. */
function toWebsiteUrl(hostname: string, protocol?: string | null): string {
  const scheme = protocol === 'http' || !protocol ? 'https' : protocol;
  return `${scheme}://${hostname}/`;
}

export function selectProductionUrl(
  group: CanonicalSite,
  live: LiveCheck | undefined,
): ProductionUrlDecision {
  const fallback = toWebsiteUrl(group.candidateHost);

  if (!live || !live.ok || live.status === undefined || !live.finalHostname) {
    return {
      websiteUrl: fallback,
      confidence: 'low',
      reason: `live check failed (${live?.error ?? 'not performed'}); cannot confirm the site is live`,
      redirectDrift: null,
    };
  }

  const reachable = live.status >= 200 && live.status < 400;
  const botProtected = BOT_PROTECTED_STATUSES.includes(live.status);
  if (!reachable && !botProtected) {
    return {
      websiteUrl: fallback,
      confidence: 'low',
      reason: `live check returned HTTP ${live.status}; cannot confirm the site is live`,
      redirectDrift: null,
    };
  }

  // A redirect that lands on another registrable site means this property is
  // not its own website. Importing it would file audits under the wrong name.
  const settled = normalizeProjectDomain(`https://${live.finalHostname}/`);
  if (settled && settled !== group.domain) {
    return {
      websiteUrl: fallback,
      confidence: 'low',
      reason:
        `GSC property ${group.domain} redirects to a different domain (${settled}); ` +
        'importing it would create a project that is not its own website',
      redirectDrift: { from: group.domain, to: settled },
    };
  }

  if (reachable) {
    return {
      websiteUrl: toWebsiteUrl(live.finalHostname, live.finalProtocol),
      confidence: 'high',
      reason: `live check returned HTTP ${live.status} at ${live.finalUrl ?? fallback}`,
      redirectDrift: null,
    };
  }

  // Bot-protected: a GSC URL-prefix declaring the same host is independent
  // confirmation, so the block stops mattering.
  const declared = group.members.some(
    (m) => m.propertyType === 'URL_PREFIX_PROPERTY' && m.hostname === live.finalHostname,
  );
  return {
    websiteUrl: toWebsiteUrl(live.finalHostname, live.finalProtocol),
    confidence: declared ? 'high' : 'medium',
    reason:
      `live check returned HTTP ${live.status} (bot protection) but resolved to ${live.finalUrl ?? fallback}` +
      (declared ? '; a GSC URL-prefix property declares the same host' : ''),
    redirectDrift: null,
  };
}

// ── project naming ────────────────────────────────────────────────

/** A stored name is unusable when it is empty or a raw URL. */
export function isUnusableProjectName(name: string | null | undefined): boolean {
  const n = (name ?? '').trim();
  if (!n) return true;
  return /^https?:\/\//i.test(n);
}

/**
 * Prefer a real publication name; fall back to the normalized domain.
 * Never the full URL — that is what made the existing rows unreadable.
 */
export function deriveProjectName(domain: string, siteName?: string | null): string {
  const candidate = (siteName ?? '').trim();
  if (!candidate) return domain;
  if (/^https?:\/\//i.test(candidate)) return domain;
  if (candidate.length < 2 || candidate.length > 120) return domain;
  return candidate;
}

// ── the plan ──────────────────────────────────────────────────────

export type PlanAction = 'create' | 'update' | 'unchanged' | 'non_production' | 'ambiguous';

export interface PlanEntry {
  action: PlanAction;
  domain: string;
  existingProjectId: string | null;
  currentProjectName: string | null;
  currentDomain: string | null;
  currentWebsiteUrl: string | null;
  gscProperties: string[];
  gscPropertyTypes: PropertyType[];
  permissionLevels: (string | null)[];
  proposedWebsiteUrl: string | null;
  proposedProjectName: string | null;
  /** Field-level before/after, present only for `update`. */
  changes: { field: string; before: string | null; after: string }[];
  reason: string;
  confidence: Confidence;
  nonProductionMarkers: string[];
  redirectDrift: { from: string; to: string } | null;
}

export interface DuplicateGroup {
  domain: string;
  rows: { id: string; domain: string; projectName: string | null; auditCount: number }[];
}

export interface SyncPlan {
  create: PlanEntry[];
  update: PlanEntry[];
  unchanged: PlanEntry[];
  nonProduction: PlanEntry[];
  ambiguous: PlanEntry[];
  /** DB rows with no GSC counterpart — reported, never removed. */
  notInGsc: PlanEntry[];
  duplicates: DuplicateGroup[];
  totals: {
    totalProperties: number;
    domainProperties: number;
    urlPrefixProperties: number;
    uniqueDomains: number;
    unparsableProperties: number;
    existingProjects: number;
    toCreate: number;
    toUpdate: number;
    unchanged: number;
    nonProduction: number;
    ambiguous: number;
    notInGsc: number;
    duplicates: number;
    expectedProjectsAfterApply: number;
  };
}

export interface PlanInput {
  properties: ParsedProperty[];
  unparsable?: string[];
  existingProjects: ExistingProject[];
  /** Keyed by canonical domain. Absent entries are treated as "not checked". */
  liveChecks?: Record<string, LiveCheck>;
}

export function planSync(input: PlanInput): SyncPlan {
  const { properties, existingProjects } = input;
  const liveChecks = input.liveChecks ?? {};
  const unparsable = input.unparsable ?? [];

  const byDomain = new Map<string, ExistingProject>();
  const collisions = new Map<string, ExistingProject[]>();
  for (const project of existingProjects) {
    const key = normalizeProjectDomain(project.domain);
    if (!key) continue;
    if (!byDomain.has(key)) byDomain.set(key, project);
    const bucket = collisions.get(key);
    if (bucket) bucket.push(project);
    else collisions.set(key, [project]);
  }

  const groups = groupByCanonicalDomain(properties);
  const plan: SyncPlan = {
    create: [], update: [], unchanged: [], nonProduction: [], ambiguous: [], notInGsc: [],
    duplicates: [],
    totals: {
      totalProperties: properties.length,
      domainProperties: properties.filter((p) => p.propertyType === 'DOMAIN_PROPERTY').length,
      urlPrefixProperties: properties.filter((p) => p.propertyType === 'URL_PREFIX_PROPERTY').length,
      uniqueDomains: groups.length,
      unparsableProperties: unparsable.length,
      existingProjects: existingProjects.length,
      toCreate: 0, toUpdate: 0, unchanged: 0, nonProduction: 0,
      ambiguous: 0, notInGsc: 0, duplicates: 0,
      expectedProjectsAfterApply: existingProjects.length,
    },
  };

  for (const group of groups) {
    const existing = byDomain.get(group.domain) ?? null;
    const live = liveChecks[group.domain];
    const decision = selectProductionUrl(group, live);
    const markers = nonProductionMarkers(group.domain);

    const base: PlanEntry = {
      action: 'unchanged',
      domain: group.domain,
      existingProjectId: existing?.id ?? null,
      currentProjectName: existing?.project_name ?? null,
      currentDomain: existing?.domain ?? null,
      currentWebsiteUrl: existing?.website_url ?? null,
      gscProperties: group.members.map((m) => m.originalProperty),
      gscPropertyTypes: [...new Set(group.members.map((m) => m.propertyType))],
      permissionLevels: [...new Set(group.members.map((m) => m.permissionLevel))],
      proposedWebsiteUrl: decision.websiteUrl,
      proposedProjectName: null,
      changes: [],
      reason: decision.reason,
      confidence: decision.confidence,
      nonProductionMarkers: markers,
      redirectDrift: decision.redirectDrift,
    };

    if (markers.length > 0) {
      plan.nonProduction.push({
        ...base,
        action: 'non_production',
        proposedWebsiteUrl: null,
        reason: `non-production hostname marker(s): ${markers.join(', ')}`,
        confidence: 'high',
      });
      continue;
    }
    if (decision.confidence === 'low') {
      plan.ambiguous.push({ ...base, action: 'ambiguous', proposedWebsiteUrl: null });
      continue;
    }

    const derivedName = deriveProjectName(group.domain, live?.siteName);

    if (!existing) {
      plan.create.push({ ...base, action: 'create', proposedProjectName: derivedName });
      continue;
    }

    // Keep a good existing name: the POST upsert rewrites project_name on
    // conflict, so a URL-only fix must resend the name it should keep.
    const keepName = isUnusableProjectName(existing.project_name)
      ? derivedName
      : (existing.project_name as string).trim();

    const changes: PlanEntry['changes'] = [];
    if ((existing.website_url ?? null) !== decision.websiteUrl) {
      changes.push({
        field: 'website_url',
        before: existing.website_url ?? null,
        after: decision.websiteUrl,
      });
    }
    if (isUnusableProjectName(existing.project_name)) {
      changes.push({
        field: 'project_name',
        before: existing.project_name ?? null,
        after: derivedName,
      });
    }

    if (changes.length === 0) {
      plan.unchanged.push({ ...base, proposedProjectName: keepName });
    } else {
      plan.update.push({ ...base, action: 'update', proposedProjectName: keepName, changes });
    }
  }

  // DB rows with no GSC counterpart — retained and reported, never deleted.
  const gscDomains = new Set(groups.map((g) => g.domain));
  for (const project of existingProjects) {
    const key = normalizeProjectDomain(project.domain);
    if (!key || gscDomains.has(key)) continue;
    const markers = nonProductionMarkers(project.domain);
    const entry: PlanEntry = {
      action: markers.length ? 'non_production' : 'unchanged',
      domain: key,
      existingProjectId: project.id,
      currentProjectName: project.project_name ?? null,
      currentDomain: project.domain,
      currentWebsiteUrl: project.website_url ?? null,
      gscProperties: [],
      gscPropertyTypes: [],
      permissionLevels: [],
      proposedWebsiteUrl: null,
      proposedProjectName: null,
      changes: [],
      reason: markers.length
        ? `manually added non-production host (${markers.join(', ')}); absent from Smacient GSC results`
        : 'project exists in the database but no Smacient GSC property matches it',
      confidence: 'high',
      nonProductionMarkers: markers,
      redirectDrift: null,
    };
    if (markers.length) plan.nonProduction.push(entry);
    else plan.notInGsc.push(entry);
  }

  for (const [domain, rows] of collisions) {
    if (rows.length < 2) continue;
    plan.duplicates.push({
      domain,
      rows: rows.map((r) => ({
        id: r.id,
        domain: r.domain,
        projectName: r.project_name ?? null,
        auditCount: r.audit_count ?? 0,
      })),
    });
  }

  plan.totals.toCreate = plan.create.length;
  plan.totals.toUpdate = plan.update.length;
  plan.totals.unchanged = plan.unchanged.length;
  plan.totals.nonProduction = plan.nonProduction.length;
  plan.totals.ambiguous = plan.ambiguous.length;
  plan.totals.notInGsc = plan.notInGsc.length;
  plan.totals.duplicates = plan.duplicates.length;
  plan.totals.expectedProjectsAfterApply = existingProjects.length + plan.create.length;
  return plan;
}

/**
 * The request body for one apply-mode POST /api/projects call.
 *
 * Only project_name and website_url are ever sent: homeUrl / articleUrl are
 * omitted so the route's COALESCE keeps whatever audit configuration the
 * project already has, and no audit is ever triggered.
 */
export function buildUpsertBody(entry: PlanEntry): { project_name: string; website_url: string } {
  if (!entry.proposedWebsiteUrl || !entry.proposedProjectName) {
    throw new Error(`entry for ${entry.domain} is not applyable`);
  }
  return { project_name: entry.proposedProjectName, website_url: entry.proposedWebsiteUrl };
}
