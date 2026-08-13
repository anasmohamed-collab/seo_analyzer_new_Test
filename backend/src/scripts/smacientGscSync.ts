/**
 * smacient:gsc-sync — synchronize SEO Analyzer projects with the Google
 * Search Console properties reported by Smacient MCP.
 *
 *   npm run smacient:gsc-sync -- --dry-run --create-only
 *   npm run smacient:gsc-sync -- --apply   --create-only
 *
 * The property list always originates from the Smacient MCP tool
 * `query-web-performance`, action `gsc_list_sites`. This command never calls
 * Google directly, never creates credentials, and never infers the property
 * list from the database. The verbatim MCP responses are supplied via --input
 * as a `{ "pages": [ … ] }` envelope containing every collected page.
 *
 * Dry run is the default and performs zero writes.
 *
 * Apply requires an explicit mode:
 *
 *   --create-only    the safe import path. Only `plan.create` is written, and
 *                    each write uses the POST /api/projects `create_only:true`
 *                    contract, which is a single atomic
 *                    INSERT … ON CONFLICT (domain) DO NOTHING. An existing
 *                    project is never updated, and a project that appears
 *                    between planning and the write returns 409 and halts the
 *                    run instead of being overwritten.
 *
 *   --allow-updates  the legacy upsert path, kept for callers that genuinely
 *                    want website_url / project_name corrections applied. It
 *                    can modify existing projects and must be chosen
 *                    deliberately.
 *
 * `--with-audit-config` (create-only only) additionally resolves and validates
 * a homeUrl + articleUrl pair per website and stores it in the same atomic
 * INSERT. Only a complete, high-confidence pair is eligible. A configured row
 * is AUTOMATION-READY — see AUTOMATION_READY_WARNING in ../lib/gscSyncCli.ts.
 *
 * Neither mode ever deletes, merges, PATCHes, triggers an audit, sends a
 * notification, enables a schedule, or reclassifies an environment.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import {
  buildCreateOnlyBody,
  collectGscProperties,
  GscCollectionError,
  groupByCanonicalDomain,
  parseProperties,
  planSync,
  type CollectedGscProperties,
  type CreateOnlyAuditConfig,
  type LiveCheck,
  type PlanEntry,
  type ProjectInventoryRecord,
  type SyncPlan,
} from '../lib/gscSync.js';
import { applyPlanVerified, fetchInventory } from '../lib/gscSyncApply.js';
import {
  assertAllowedTarget,
  AUTOMATION_READY_WARNING,
  buildCoverage,
  collapsedPropertyGroups,
  extractSiteName,
  modeLabel,
  parseArgs,
  sanitize,
  UsageError,
  type CoverageReport,
  type Options,
} from '../lib/gscSyncCli.js';
import { resolveAuditConfig, type AuditConfigResolution } from '../lib/gscAuditConfig.js';
import type { GscPropertyPerformance } from '../lib/articleCandidates.js';
import type { PageResult } from '../lib/auditConfigDiscovery.js';
import { runFetchEngine } from '../services/fetch/fetchEngine.js';

const USER_AGENT = 'seo-analyzer-smacient-gsc-sync/1.0';

// ── live check ────────────────────────────────────────────────────

async function probeHomepage(host: string): Promise<LiveCheck> {
  try {
    const res = await fetch(`https://${host}/`, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(20_000),
    });
    let html = '';
    const reader = res.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      let bytes = 0;
      while (bytes < 120_000) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        html += decoder.decode(value, { stream: true });
      }
      await reader.cancel().catch(() => undefined);
    }
    const finalUrl = new URL(res.url);
    return {
      ok: true,
      status: res.status,
      finalUrl: res.url,
      finalHostname: finalUrl.hostname.toLowerCase(),
      finalProtocol: finalUrl.protocol.replace(':', ''),
      siteName: extractSiteName(html),
    };
  } catch (err) {
    return { ok: false, error: sanitize(String((err as Error).message ?? err)) };
  }
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await fn(items[cursor++]);
  });
  await Promise.all(workers);
}

// ── audit-config discovery I/O ────────────────────────────────────

/** One in-flight request per hostname, matching audit-config:discover. */
const hostLocks = new Map<string, Promise<unknown>>();

async function withHostLock<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const previous = hostLocks.get(host) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  hostLocks.set(host, run.then(() => undefined, () => undefined));
  return run;
}

/**
 * The project's own fetch stack, so bot-protection detection, timeouts and UA
 * profiles behave exactly as they do during a real audit. Read-only: this only
 * ever issues GETs against public pages.
 */
async function fetchPage(url: string): Promise<PageResult> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, httpStatus: 0, finalUrl: '', redirectChain: [], html: '', challengeDetected: false, error: 'invalid URL' };
  }
  return withHostLock(host, async () => {
    try {
      const r = await runFetchEngine(url, {
        signal: AbortSignal.timeout(30_000),
        timeoutMs: 30_000,
        maxBytes: 3 * 1024 * 1024,
      });
      return {
        ok: r.fetchOk,
        httpStatus: r.httpStatus,
        finalUrl: r.finalUrl || url,
        redirectChain: r.redirectChain ?? [],
        html: r.html ?? '',
        challengeDetected: r.challengeDetected,
        error: r.fetchOk ? null : (r.blockedReason ?? `fetch failed (HTTP ${r.httpStatus})`),
      };
    } catch (err) {
      return {
        ok: false, httpStatus: 0, finalUrl: '', redirectChain: [], html: '',
        challengeDetected: false, error: sanitize(String((err as Error).message ?? err)),
      };
    }
  });
}

/**
 * Read captured `gsc_top_pages` responses.
 *
 * Shape: `{ "properties": [ <verbatim gsc_top_pages response>, … ] }`. Each
 * response must carry the `site_url` it was requested for so a candidate can
 * be attributed back to its source property in the report.
 */
function readGscPageData(path: string): GscPropertyPerformance[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as
    | { properties?: GscPropertyPerformance[] }
    | GscPropertyPerformance[];
  const properties = Array.isArray(parsed) ? parsed : parsed.properties;
  if (!Array.isArray(properties)) {
    throw new Error(`${path} contains no properties array`);
  }
  for (const p of properties) {
    if (!p || typeof p.site_url !== 'string' || !p.site_url.trim()) {
      throw new Error(`${path} contains a page-performance response with no site_url`);
    }
  }
  return properties;
}

// ── captured inventory input ──────────────────────────────────────

/** Read a previously captured GET /api/projects response from disk. */
function readInventoryFile(path: string): ProjectInventoryRecord[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as
    | { projects?: ProjectInventoryRecord[] }
    | ProjectInventoryRecord[];
  const projects = Array.isArray(parsed) ? parsed : parsed.projects;
  if (!Array.isArray(projects)) {
    throw new Error(`${path} contains no projects array`);
  }
  for (const project of projects) {
    if (!project || typeof project.id !== 'string' || typeof project.domain !== 'string') {
      throw new Error(`${path} contains a project row with no id/domain`);
    }
  }
  return projects;
}

// ── report shaping ────────────────────────────────────────────────

/** Everything the report must show for one proposed creation. */
function describeCreation(
  entry: PlanEntry,
  resolution: AuditConfigResolution | undefined,
  config: CreateOnlyAuditConfig | undefined,
): Record<string, unknown> {
  return {
    canonicalDomain: entry.domain,
    finalCategory: config ? 'safe_create_configured' : 'safe_create_identity_only',
    gscProperties: entry.gscProperties,
    gscPropertyTypes: entry.gscPropertyTypes,
    permissionLevels: entry.permissionLevels,
    proposedProjectName: entry.proposedProjectName,
    verifiedWebsiteUrl: entry.proposedWebsiteUrl,
    websiteConfidence: entry.confidence,
    websiteEvidence: entry.reason,
    verifiedHomeUrl: resolution?.homeUrl ?? null,
    homepageStatus: resolution?.homepageStatus ?? null,
    homepageRedirectChain: resolution?.homepageRedirectChain ?? [],
    homepageEvidence: resolution?.homepageReason ?? null,
    verifiedArticleUrl: resolution?.articleUrl ?? null,
    articleSource: resolution?.articleSource ?? null,
    articleGscProperty: resolution?.gscEvidence?.siteUrl ?? null,
    articleGscDateRange: resolution?.gscEvidence
      ? { start: resolution.gscEvidence.startDate, end: resolution.gscEvidence.endDate }
      : null,
    articleGscClicks: resolution?.gscEvidence?.clicks ?? null,
    articleGscImpressions: resolution?.gscEvidence?.impressions ?? null,
    articleGscPosition: resolution?.gscEvidence?.position ?? null,
    articleFinalCanonical: resolution?.articleCanonical ?? null,
    articleHttpStatus: resolution?.articleStatus ?? null,
    articleValidationSignals: resolution?.articleSignals ?? [],
    articleConfidence: resolution?.articleConfidence ?? null,
    articleEvidence: resolution?.articleReason ?? null,
    candidatesConsidered: resolution?.candidatesConsidered ?? 0,
    candidatesTried: resolution?.candidatesTried ?? 0,
    candidateAttempts: resolution?.attempts ?? [],
    sourcesTried: resolution?.sourcesTried ?? [],
    usedFallbackDiscovery: resolution?.usedFallback ?? false,
    gscCandidateReport: resolution?.gscCandidateReport ?? [],
    heldBackReason: config ? null : (resolution?.reason ?? 'audit-config resolution not requested'),
    requestBody: buildCreateOnlyBody(entry, config ?? null),
  };
}

// ── console report ────────────────────────────────────────────────

function printReport(
  plan: SyncPlan,
  collected: CollectedGscProperties,
  coverage: CoverageReport,
  opts: Options,
  resolutions: Record<string, AuditConfigResolution>,
  auditConfig: Record<string, CreateOnlyAuditConfig>,
): void {
  const t = plan.totals;
  const log = console.log;
  log('');
  log('Smacient GSC → SEO Analyzer sync');
  log(`  mode                  ${modeLabel(opts)}`);
  log(`  target                ${opts.apiBase}`);
  log('  source                Smacient MCP query-web-performance / gsc_list_sites');
  log('');
  const configured = plan.create.filter((e) => auditConfig[e.domain]);
  const identityOnly = plan.create.filter((e) => !auditConfig[e.domain]);

  log(`  pages collected       ${collected.pageCount}  (entries per page: ${collected.entriesPerPage.join(', ')})`);
  log(`  raw entries returned  ${collected.rawEntryCount}`);
  log(`  usable site_url       ${collected.usableEntryCount}`);
  log(`  malformed entries     ${collected.malformedEntryCount}`);
  log(`  exact duplicates      ${collected.exactDuplicateCount}`);
  log(`  unique properties     ${collected.uniquePropertyCount}  (domain ${t.domainProperties}, url-prefix ${t.urlPrefixProperties})`);
  log(`  unique canonical webs ${t.uniqueDomains}`);
  log(`  entry accounting      ${collected.rawEntryCount} = ${collected.usableEntryCount} usable + ${collected.malformedEntryCount} malformed; ` +
      `${collected.usableEntryCount} = ${collected.uniquePropertyCount} unique + ${collected.exactDuplicateCount} duplicates — ${collected.reconciled ? 'RECONCILED' : 'MISMATCH'}`);
  if (t.unparsableProperties) log(`  unparsable            ${t.unparsableProperties}`);
  log(`  existing projects     ${t.existingProjects}`);
  log('');
  log(`  already represented   ${t.unchanged + t.toUpdate}`);
  log(`  safe to create        ${t.toCreate}`);
  if (opts.withAuditConfig) {
    log(`    configured          ${configured.length}  (validated homeUrl + articleUrl — automation-ready)`);
    log(`    identity only       ${identityOnly.length}  (no high-confidence pair)`);
  }
  log(`  proposed updates      ${t.toUpdate}${opts.createOnly ? '  (reported only — create-only never writes these)' : ''}`);
  log(`  non-production        ${t.nonProduction}`);
  log(`  ambiguous             ${t.ambiguous}`);
  log(`  database duplicates   ${t.duplicates}`);
  log(`  in DB, not in GSC     ${t.notInGsc}`);
  log(`  projects after apply  ${t.expectedProjectsAfterApply}`);
  log('');
  log(`  coverage              ${coverage.accountedProperties}/${coverage.uniqueProperties} properties categorized — ${coverage.complete ? 'COMPLETE' : 'INCOMPLETE'}`);
  log('');

  if (plan.create.length) {
    log('CREATE (safe canonical websites)');
    for (const e of plan.create) {
      const r = resolutions[e.domain];
      const cfg = auditConfig[e.domain];
      log(`  + ${e.domain}   [${cfg ? 'safe_create_configured' : 'safe_create_identity_only'}]`);
      log(`      properties     ${e.gscProperties.join(', ')}`);
      log(`      permission     ${e.permissionLevels.map((p) => p ?? 'unknown').join(', ')}`);
      log(`      website_url    ${e.proposedWebsiteUrl}`);
      log(`      project_name   "${e.proposedProjectName}"`);
      log(`      confidence     ${e.confidence} — ${e.reason}`);
      if (!r) continue;
      log(`      homeUrl        ${r.homeUrl ?? '(not verified)'}  HTTP ${r.homepageStatus ?? '-'}`);
      if (r.articleUrl) {
        log(`      articleUrl     ${r.articleUrl}  HTTP ${r.articleStatus}  [${r.articleConfidence}]`);
        log(`      article src    ${r.articleSource}${r.gscEvidence ? ` from ${r.gscEvidence.siteUrl} (${r.gscEvidence.startDate}..${r.gscEvidence.endDate}, ${r.gscEvidence.clicks} clicks / ${r.gscEvidence.impressions} impressions)` : ''}`);
        log(`      article signals ${r.articleSignals.join(', ') || 'none'}`);
        if (r.articleCanonical) log(`      article canonical ${r.articleCanonical}`);
      } else {
        log(`      articleUrl     (none) — ${r.articleReason}`);
      }
      log(`      candidates     ${r.candidatesTried} tried of ${r.candidatesConsidered} considered; sources: ${r.sourcesTried.join(', ') || 'none'}${r.usedFallback ? ' (fallback used)' : ''}`);
      if (!cfg) log(`      HELD BACK      ${r.reason}`);
    }
    log('');
  }
  if (plan.update.length) {
    log(opts.createOnly
      ? 'PROPOSED UPDATES (create-only ignores these — review separately)'
      : 'UPDATE');
    for (const e of plan.update) {
      log(`  ~ ${e.domain}  (project ${e.existingProjectId})`);
      for (const c of e.changes) log(`      ${c.field}: ${c.before ?? 'null'}  ->  ${c.after}`);
    }
    log('');
  }
  if (plan.nonProduction.length) {
    log('NON-PRODUCTION (manual classification — never created, never deleted)');
    for (const e of plan.nonProduction) log(`  ! ${e.domain.padEnd(32)} ${e.reason}`);
    log('');
  }
  if (plan.ambiguous.length) {
    log('AMBIGUOUS (manual review — no action)');
    for (const e of plan.ambiguous) log(`  ? ${e.domain.padEnd(32)} ${e.reason}`);
    log('');
  }
  if (plan.duplicates.length) {
    log('DATABASE DUPLICATES (reported only — never merged)');
    for (const d of plan.duplicates) log(`  = ${d.domain}: ${d.rows.map((r) => `${r.id} (${r.auditCount} audits)`).join(', ')}`);
    log('');
  }
  if (plan.notInGsc.length) {
    log('IN DATABASE, NOT IN GSC (retained)');
    for (const e of plan.notInGsc) log(`  ? ${e.domain.padEnd(32)} ${e.reason}`);
    log('');
  }
  if (!coverage.complete) {
    log('COVERAGE FAILURE — these properties are not categorized exactly once:');
    for (const line of coverage.unaccounted) log(`  ! ${line}`);
    log('');
  }
}

// ── main ──────────────────────────────────────────────────────────

async function main(): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    throw err;
  }
  assertAllowedTarget(opts.apiBase);

  if (!opts.input) {
    console.error(
      'error: --input <file> is required.\n' +
        '       Capture every Smacient MCP page first:\n' +
        '         tool   query-web-performance\n' +
        '         action gsc_list_sites\n' +
        '       and save them verbatim as {"pages":[<page1>,<page2>,…]}.',
    );
    return 1;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(opts.input, 'utf8'));
  } catch (err) {
    console.error(`error: cannot read Smacient input: ${sanitize(String((err as Error).message))}`);
    return 1;
  }

  // Fail closed: an incomplete or looping collection must never be planned on.
  let collected: CollectedGscProperties;
  try {
    collected = collectGscProperties(payload, {
      expectedUniqueProperties: opts.expectProperties,
      expectedRawEntries: opts.expectRawEntries,
    });
  } catch (err) {
    if (err instanceof GscCollectionError) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const { properties, unparsable } = parseProperties(collected.sites);
  for (const bad of unparsable) console.error(`warning: unparsable GSC property reported, not created: ${bad}`);

  let inventoryBefore: ProjectInventoryRecord[];
  try {
    inventoryBefore = opts.existingProjects
      ? readInventoryFile(opts.existingProjects)
      : await fetchInventory(opts.apiBase);
  } catch (err) {
    console.error(`error: cannot read existing projects: ${sanitize(String((err as Error).message))}`);
    return 1;
  }

  const liveChecks: Record<string, LiveCheck> = {};
  if (opts.liveCheck) {
    const groups = groupByCanonicalDomain(properties);
    await runPool(groups, opts.concurrency, async (group) => {
      liveChecks[group.domain] = await probeHomepage(group.candidateHost);
    });
  }

  const plan = planSync({
    properties,
    unparsable,
    existingProjects: inventoryBefore,
    liveChecks,
  });
  const coverage = buildCoverage(collected, plan, unparsable);

  // ── audit-configuration resolution ──────────────────────────────
  //
  // Only ever attempted for websites the planner already classified as a safe
  // creation, and only when the operator asked for it. Resolution is pure
  // read-only HTTP: it validates, it never writes.
  const resolutions: Record<string, AuditConfigResolution> = {};
  const auditConfig: Record<string, CreateOnlyAuditConfig> = {};
  if (opts.withAuditConfig) {
    let performances: GscPropertyPerformance[] = [];
    if (opts.gscPageData) {
      try {
        performances = readGscPageData(opts.gscPageData);
      } catch (err) {
        console.error(`error: cannot read GSC page data: ${sanitize(String((err as Error).message))}`);
        return 1;
      }
    } else {
      console.error(
        'warning: --with-audit-config without --gsc-page-data — Search Console page\n' +
          '         performance is unavailable, so article discovery falls back to\n' +
          '         sitemaps, feeds and homepage links only.',
      );
    }

    // Attribute each captured response to the canonical website that owns its
    // GSC property, so a website is only offered its own performance data.
    const byDomain = new Map<string, GscPropertyPerformance[]>();
    for (const performance of performances) {
      const parsedProperty = parseProperties([{ site_url: performance.site_url }]).properties[0];
      if (!parsedProperty) {
        console.error(`warning: GSC page data for an unparsable property ignored: ${performance.site_url}`);
        continue;
      }
      const bucket = byDomain.get(parsedProperty.normalizedDomain);
      if (bucket) bucket.push(performance);
      else byDomain.set(parsedProperty.normalizedDomain, [performance]);
    }

    for (const entry of plan.create) {
      const resolution = await resolveAuditConfig({
        domain: entry.domain,
        websiteUrl: entry.proposedWebsiteUrl as string,
        gscPerformance: byDomain.get(entry.domain) ?? [],
        fetchPage,
      });
      resolutions[entry.domain] = resolution;
      if (resolution.eligibleForConfiguredCreate && resolution.homeUrl && resolution.articleUrl) {
        auditConfig[entry.domain] = { homeUrl: resolution.homeUrl, articleUrl: resolution.articleUrl };
      }
    }
  }

  const configuredCreations = plan.create.filter((e) => auditConfig[e.domain]);
  const identityOnlyCreations = plan.create.filter((e) => !auditConfig[e.domain]);

  printReport(plan, collected, coverage, opts, resolutions, auditConfig);

  const alreadyRepresented = [...plan.unchanged, ...plan.update];
  const summary: Record<string, unknown> = {
    mode: opts.apply ? 'apply' : 'dry-run',
    writeMode: opts.createOnly ? 'create-only' : opts.allowUpdates ? 'legacy-upsert' : 'none',
    source: { provider: 'Smacient MCP', tool: 'query-web-performance', action: 'gsc_list_sites' },
    target: opts.apiBase,
    existingProjectsSource: opts.existingProjects
      ? { kind: 'captured-file', path: opts.existingProjects }
      : { kind: 'GET /api/projects', target: opts.apiBase },
    collection: {
      pagesCollected: collected.pageCount,
      pageTokens: collected.pageTokens,
      entriesPerPage: collected.entriesPerPage,
      rawEntryCount: collected.rawEntryCount,
      entriesWithUsableSiteUrl: collected.usableEntryCount,
      malformedEntryCount: collected.malformedEntryCount,
      rawPropertyCount: collected.rawPropertyCount,
      exactDuplicatePropertyCount: collected.exactDuplicateCount,
      uniquePropertyCount: collected.uniquePropertyCount,
      uniqueCanonicalWebsiteCount: plan.totals.uniqueDomains,
      unexplainedEntries: collected.rawEntryCount - collected.usableEntryCount - collected.malformedEntryCount,
      reconciled: collected.reconciled,
      expectedUniqueProperties: opts.expectProperties,
      expectedRawEntries: opts.expectRawEntries,
    },
    coverage,
    totals: plan.totals,
    /** The final category of every canonical website — one bucket each. */
    categories: {
      safe_create_configured: configuredCreations.map((e) => e.domain),
      safe_create_identity_only: identityOnlyCreations.map((e) => e.domain),
      already_existing: alreadyRepresented.map((e) => e.domain),
      proposed_existing_update_ignored: (opts.createOnly ? plan.update : []).map((e) => e.domain),
      non_production: plan.nonProduction.map((e) => e.domain),
      ambiguous: plan.ambiguous.map((e) => e.domain),
      unparsable,
    },
    existingCanonicalProjects: alreadyRepresented,
    safeProjectsProposedForCreation: plan.create.map((e) =>
      describeCreation(e, resolutions[e.domain], auditConfig[e.domain]),
    ),
    configuredCreations: configuredCreations.map((e) =>
      describeCreation(e, resolutions[e.domain], auditConfig[e.domain]),
    ),
    identityOnlyCreations: identityOnlyCreations.map((e) =>
      describeCreation(e, resolutions[e.domain], auditConfig[e.domain]),
    ),
    auditConfigResolutions: resolutions,
    proposedUpdatesIgnoredByCreateOnly: opts.createOnly ? plan.update : [],
    proposedUpdates: plan.update,
    collapsedDuplicateProperties: collapsedPropertyGroups(plan),
    nonProductionProperties: plan.nonProduction,
    ambiguousProperties: plan.ambiguous,
    unparsableProperties: unparsable,
    databaseDuplicates: plan.duplicates,
    inDatabaseNotInGsc: plan.notInGsc,
    expectedProjectCountAfterCreateOnlyApply: inventoryBefore.length + plan.create.length,
    automationReadyWarning: opts.withAuditConfig ? AUTOMATION_READY_WARNING : null,
    writesPerformed: 0,
    auditsTriggered: 0,
    projectsUpdated: 0,
    projectsDeleted: 0,
    projectsMerged: 0,
    notificationsSent: 0,
  };

  const writeSummary = (): void => {
    if (opts.jsonOut) writeFileSync(opts.jsonOut, JSON.stringify(summary, null, 2), 'utf8');
  };

  if (!coverage.complete) {
    summary.halted = 'coverage incomplete — some GSC properties are not categorized exactly once';
    writeSummary();
    console.error('error: coverage is incomplete; refusing to continue. No writes were performed.');
    return 1;
  }

  if (!opts.apply) {
    writeSummary();
    console.log('Dry run complete — 0 writes performed, 0 audits triggered, 0 projects updated or deleted.');
    return 0;
  }

  // ── apply ───────────────────────────────────────────────────────
  //
  // In create-only mode `plan.update` is deliberately not part of this list.
  // Proposed updates were printed above and written to the JSON report; they
  // are never sent.
  const applyable = opts.createOnly ? plan.create : [...plan.create, ...plan.update];

  if (opts.withAuditConfig) {
    console.log('');
    console.log(AUTOMATION_READY_WARNING);
    console.log('');
    console.log(`  ${configuredCreations.length} project(s) would be created AUTOMATION-READY:`);
    for (const e of configuredCreations) console.log(`    - ${e.domain}`);
    console.log('');
  }

  // Both inventory snapshots come from the live target: the before-read
  // happens immediately before the first write and the after-read immediately
  // after the last one. A captured file is rejected by parseArgs precisely so
  // it can never stand in for either of them.
  const verified = await applyPlanVerified(opts.apiBase, applyable, {
    createOnly: opts.createOnly,
    auditConfig,
    log: (m) => console.log(m),
    error: (m) => console.error(m),
  });
  const outcome = verified.outcome;

  if (outcome.halted) {
    console.error('');
    console.error(`Apply halted after ${outcome.attempted} of ${applyable.length} planned writes.`);
    console.error('Successful writes above are preserved; no further writes were attempted.');
  }

  summary.writes = {
    attempted: outcome.attempted,
    created: outcome.created,
    configured: outcome.configured,
    updated: outcome.updated,
    conflicts: outcome.conflicts,
    failed: outcome.failed,
  };
  summary.writesPerformed = outcome.created + outcome.updated;
  summary.projectsUpdated = outcome.updated;
  summary.halted = outcome.halted;
  summary.plannedWrites = applyable.length;
  summary.results = outcome.results;
  summary.inventorySource = 'live GET /api/projects before and after the writes';
  summary.inventoryBeforeCount = verified.inventoryBefore.length;
  summary.inventoryAfterCount = verified.inventoryAfter?.length ?? null;
  summary.existingProjectPreservation = verified.comparison;
  summary.preservationVerified = verified.preservationVerified;
  summary.verificationError = verified.verificationError;
  writeSummary();

  console.log('');
  console.log(
    `Apply ${outcome.halted ? 'HALTED' : 'complete'} — created ${outcome.created} ` +
      `(${outcome.configured} automation-ready), updated ${outcome.updated}, ` +
      `conflicts ${outcome.conflicts}, failed ${outcome.failed}.`,
  );

  if (verified.preservationVerified && verified.comparison) {
    console.log(
      `Existing-project preservation VERIFIED against two live reads — ` +
        `${verified.comparison.unchangedIds.length} pre-existing projects unchanged, ` +
        `${verified.comparison.addedIds.length} added.`,
    );
  } else {
    console.error(`Existing-project preservation NOT VERIFIED: ${verified.verificationError}`);
    for (const diff of verified.comparison?.changed ?? []) {
      console.error(`  CHANGED  project ${diff.id} ${diff.field}: ${stringify(diff.before)} -> ${stringify(diff.after)}`);
    }
    for (const id of verified.comparison?.missingIds ?? []) console.error(`  MISSING  project ${id}`);
  }
  console.log('No audit was triggered. No project or audit was deleted or merged.');

  return outcome.failed > 0 || outcome.conflicts > 0 || !verified.preservationVerified ? 1 : 0;
}

function stringify(value: unknown): string {
  return value === null || value === undefined ? 'null' : JSON.stringify(value);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`fatal: ${sanitize(String((err as Error)?.message ?? err))}`);
    process.exit(1);
  });
