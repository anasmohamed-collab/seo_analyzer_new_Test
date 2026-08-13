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
 * Neither mode ever deletes, merges, PATCHes, triggers an audit, sends a
 * notification, enables a schedule, or reclassifies an environment.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import {
  buildCreateOnlyBody,
  collectGscProperties,
  compareInventories,
  GscCollectionError,
  groupByCanonicalDomain,
  parseProperties,
  planSync,
  type CollectedGscProperties,
  type InventoryComparison,
  type LiveCheck,
  type ProjectInventoryRecord,
  type SyncPlan,
} from '../lib/gscSync.js';
import { applyPlan, fetchInventory } from '../lib/gscSyncApply.js';
import {
  assertAllowedTarget,
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

// ── console report ────────────────────────────────────────────────

function printReport(
  plan: SyncPlan,
  collected: CollectedGscProperties,
  coverage: CoverageReport,
  opts: Options,
): void {
  const t = plan.totals;
  const log = console.log;
  log('');
  log('Smacient GSC → SEO Analyzer sync');
  log(`  mode                  ${modeLabel(opts)}`);
  log(`  target                ${opts.apiBase}`);
  log('  source                Smacient MCP query-web-performance / gsc_list_sites');
  log('');
  log(`  pages collected       ${collected.pageCount}`);
  log(`  raw properties        ${collected.rawPropertyCount}`);
  log(`  exact duplicates      ${collected.exactDuplicateCount}`);
  log(`  unique properties     ${collected.uniquePropertyCount}  (domain ${t.domainProperties}, url-prefix ${t.urlPrefixProperties})`);
  log(`  unique canonical webs ${t.uniqueDomains}`);
  if (t.unparsableProperties) log(`  unparsable            ${t.unparsableProperties}`);
  log(`  existing projects     ${t.existingProjects}`);
  log('');
  log(`  already represented   ${t.unchanged + t.toUpdate}`);
  log(`  safe to create        ${t.toCreate}`);
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
      log(`  + ${e.domain}`);
      log(`      properties     ${e.gscProperties.join(', ')}`);
      log(`      permission     ${e.permissionLevels.map((p) => p ?? 'unknown').join(', ')}`);
      log(`      website_url    ${e.proposedWebsiteUrl}`);
      log(`      project_name   "${e.proposedProjectName}"`);
      log(`      confidence     ${e.confidence} — ${e.reason}`);
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
    collected = collectGscProperties(payload);
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
  printReport(plan, collected, coverage, opts);

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
      rawPropertyCount: collected.rawPropertyCount,
      exactDuplicatePropertyCount: collected.exactDuplicateCount,
      uniquePropertyCount: collected.uniquePropertyCount,
      uniqueCanonicalWebsiteCount: plan.totals.uniqueDomains,
    },
    coverage,
    totals: plan.totals,
    existingCanonicalProjects: alreadyRepresented,
    safeProjectsProposedForCreation: plan.create.map((e) => ({
      canonicalDomain: e.domain,
      gscProperties: e.gscProperties,
      gscPropertyTypes: e.gscPropertyTypes,
      permissionLevels: e.permissionLevels,
      proposedWebsiteUrl: e.proposedWebsiteUrl,
      proposedProjectName: e.proposedProjectName,
      confidence: e.confidence,
      evidence: e.reason,
      requestBody: buildCreateOnlyBody(e),
    })),
    proposedUpdatesIgnoredByCreateOnly: opts.createOnly ? plan.update : [],
    proposedUpdates: plan.update,
    collapsedDuplicateProperties: collapsedPropertyGroups(plan),
    nonProductionProperties: plan.nonProduction,
    ambiguousProperties: plan.ambiguous,
    unparsableProperties: unparsable,
    databaseDuplicates: plan.duplicates,
    inDatabaseNotInGsc: plan.notInGsc,
    expectedProjectCountAfterCreateOnlyApply: inventoryBefore.length + plan.create.length,
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
  const outcome = await applyPlan(opts.apiBase, applyable, {
    createOnly: opts.createOnly,
    log: (m) => console.log(m),
    error: (m) => console.error(m),
  });

  if (outcome.halted) {
    console.error('');
    console.error(`Apply halted after ${outcome.attempted} of ${applyable.length} planned writes.`);
    console.error('Successful writes above are preserved; no further writes were attempted.');
  }

  // ── prove every pre-existing project survived unchanged ─────────
  let inventoryAfter: ProjectInventoryRecord[] | null = null;
  let comparison: InventoryComparison | null = null;
  try {
    inventoryAfter = opts.existingProjects
      ? readInventoryFile(opts.existingProjects)
      : await fetchInventory(opts.apiBase);
    comparison = compareInventories(inventoryBefore, inventoryAfter);
  } catch (err) {
    console.error(`error: cannot re-read projects to verify preservation: ${sanitize(String((err as Error).message))}`);
  }

  summary.writes = {
    attempted: outcome.attempted,
    created: outcome.created,
    updated: outcome.updated,
    conflicts: outcome.conflicts,
    failed: outcome.failed,
  };
  summary.writesPerformed = outcome.created + outcome.updated;
  summary.projectsUpdated = outcome.updated;
  summary.halted = outcome.halted;
  summary.plannedWrites = applyable.length;
  summary.results = outcome.results;
  summary.inventoryBeforeCount = inventoryBefore.length;
  summary.inventoryAfterCount = inventoryAfter?.length ?? null;
  summary.existingProjectPreservation = comparison;
  writeSummary();

  console.log('');
  console.log(
    `Apply ${outcome.halted ? 'HALTED' : 'complete'} — created ${outcome.created}, ` +
      `updated ${outcome.updated}, conflicts ${outcome.conflicts}, failed ${outcome.failed}.`,
  );
  if (comparison) {
    console.log(
      comparison.preserved
        ? `Existing-project preservation VERIFIED — ${comparison.unchangedIds.length} pre-existing projects unchanged, ${comparison.addedIds.length} added.`
        : 'Existing-project preservation FAILED — see existingProjectPreservation in the JSON report.',
    );
    for (const diff of comparison.changed) {
      console.error(`  CHANGED  project ${diff.id} ${diff.field}: ${stringify(diff.before)} -> ${stringify(diff.after)}`);
    }
    for (const id of comparison.missingIds) console.error(`  MISSING  project ${id}`);
  }
  console.log('No audit was triggered. No project or audit was deleted or merged.');

  const preservationFailed = comparison ? !comparison.preserved : true;
  return outcome.failed > 0 || outcome.conflicts > 0 || preservationFailed ? 1 : 0;
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
