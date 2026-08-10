/**
 * smacient:gsc-sync — synchronize SEO Analyzer projects with the Google
 * Search Console properties reported by Smacient MCP.
 *
 *   npm run smacient:gsc-sync -- --dry-run
 *   npm run smacient:gsc-sync -- --apply
 *
 * The property list always originates from the Smacient MCP tool
 * `query-web-performance`, action `gsc_list_sites`. This command never calls
 * Google directly, never creates credentials, and never infers the property
 * list from the database. The verbatim MCP response is supplied via --input;
 * capture it with the MCP tool and hand the file to this command.
 *
 * Dry run is the default and performs zero writes. Apply mode may only create
 * missing production projects and correct website_url / unusable names. It
 * never deletes, never merges, never triggers an audit, and never touches
 * audit history or audit configuration.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import {
  buildUpsertBody,
  groupByCanonicalDomain,
  parseProperties,
  planSync,
  readSmacientSites,
  type ExistingProject,
  type LiveCheck,
  type PlanEntry,
  type SyncPlan,
} from '../lib/gscSync.js';

/** Never contact the production deployment from this tool. */
const FORBIDDEN_HOSTS = ['seo-analyzer.layoutworkflows.com'];

const DEFAULT_API = process.env.SEO_API_BASE_URL ?? 'http://localhost:3000';
const USER_AGENT = 'seo-analyzer-smacient-gsc-sync/1.0';

interface Options {
  apply: boolean;
  input: string | null;
  apiBase: string;
  jsonOut: string | null;
  liveCheck: boolean;
  concurrency: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    apply: false,
    input: null,
    apiBase: DEFAULT_API,
    jsonOut: null,
    liveCheck: true,
    concurrency: 6,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--apply': opts.apply = true; break;
      case '--dry-run': opts.apply = false; break;
      case '--no-live-check': opts.liveCheck = false; break;
      case '--input': opts.input = argv[++i] ?? null; break;
      case '--api': opts.apiBase = argv[++i] ?? DEFAULT_API; break;
      case '--json': opts.jsonOut = argv[++i] ?? null; break;
      case '--concurrency': opts.concurrency = Math.max(1, Number(argv[++i]) || 6); break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return opts;
}

/** Redact anything that looks like a token before it can reach a log line. */
function sanitize(message: string): string {
  return message
    .replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]')
    .replace(/([?&](?:key|token|access_token|api_key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//[redacted]@');
}

function assertAllowedTarget(apiBase: string): void {
  let host: string;
  try {
    host = new URL(apiBase).hostname.toLowerCase();
  } catch {
    throw new Error(`Invalid --api base URL: ${apiBase}`);
  }
  if (FORBIDDEN_HOSTS.includes(host)) {
    throw new Error(`Refusing to target the production host ${host}`);
  }
}

// ── HTML helpers ──────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
};

function decodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m] ?? m);
}

/**
 * Read og:site_name. The content value is delimited with a backreference so a
 * name containing an apostrophe (`Pouvoirs d'Afrique`) is not truncated.
 */
export function extractSiteName(html: string): string {
  const patterns = [
    /<meta[^>]+?property=["']og:site_name["'][^>]*?content=(["'])([\s\S]*?)\1/i,
    /<meta[^>]+?content=(["'])([\s\S]*?)\1[^>]*?property=["']og:site_name["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[2]?.trim()) return decodeEntities(m[2].trim()).replace(/\s+/g, ' ');
  }
  return '';
}

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

// ── application API (read + guarded write) ────────────────────────

async function fetchExistingProjects(apiBase: string): Promise<ExistingProject[]> {
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/projects`, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GET /api/projects returned HTTP ${res.status}`);
  const body = (await res.json()) as { projects?: ExistingProject[] };
  if (!Array.isArray(body.projects)) throw new Error('GET /api/projects returned no projects array');
  return body.projects;
}

interface UpsertResult {
  domain: string;
  httpStatus: number;
  created: boolean;
  automationReady: boolean;
  projectId: string | null;
}

async function upsertProject(apiBase: string, entry: PlanEntry): Promise<UpsertResult> {
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(buildUpsertBody(entry)),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    created?: boolean;
    automation_ready?: boolean;
    project?: { id?: string };
    error?: string;
  };
  if (!res.ok && res.status !== 200 && res.status !== 201) {
    throw new Error(`POST /api/projects for ${entry.domain} returned HTTP ${res.status}: ${body.error ?? ''}`);
  }
  return {
    domain: entry.domain,
    httpStatus: res.status,
    created: Boolean(body.created),
    automationReady: Boolean(body.automation_ready),
    projectId: body.project?.id ?? null,
  };
}

// ── console report ────────────────────────────────────────────────

function printReport(plan: SyncPlan, opts: Options): void {
  const t = plan.totals;
  const log = console.log;
  log('');
  log('Smacient GSC → SEO Analyzer sync');
  log(`  mode                  ${opts.apply ? 'APPLY' : 'DRY RUN (no writes)'}`);
  log(`  target                ${opts.apiBase}`);
  log(`  source                Smacient MCP query-web-performance / gsc_list_sites`);
  log('');
  log(`  properties returned   ${t.totalProperties}  (domain ${t.domainProperties}, url-prefix ${t.urlPrefixProperties})`);
  if (t.unparsableProperties) log(`  unparsable            ${t.unparsableProperties}`);
  log(`  unique domains        ${t.uniqueDomains}`);
  log(`  existing projects     ${t.existingProjects}`);
  log('');
  log(`  create                ${t.toCreate}`);
  log(`  update                ${t.toUpdate}`);
  log(`  unchanged             ${t.unchanged}`);
  log(`  non-production        ${t.nonProduction}`);
  log(`  duplicates            ${t.duplicates}`);
  log(`  in DB, not in GSC     ${t.notInGsc}`);
  log(`  ambiguous             ${t.ambiguous}`);
  log(`  projects after apply  ${t.expectedProjectsAfterApply}`);
  log('');

  if (plan.create.length) {
    log('CREATE');
    for (const e of plan.create) log(`  + ${e.domain.padEnd(32)} ${e.proposedWebsiteUrl}  "${e.proposedProjectName}"  [${e.confidence}]`);
    log('');
  }
  if (plan.update.length) {
    log('UPDATE');
    for (const e of plan.update) {
      log(`  ~ ${e.domain}  (project ${e.existingProjectId})`);
      for (const c of e.changes) log(`      ${c.field}: ${c.before ?? 'null'}  ->  ${c.after}`);
    }
    log('');
  }
  if (plan.nonProduction.length) {
    log('NON-PRODUCTION (classified only — never created, never deleted)');
    for (const e of plan.nonProduction) log(`  ! ${e.domain.padEnd(32)} ${e.reason}`);
    log('');
  }
  if (plan.duplicates.length) {
    log('DUPLICATES (reported only — never merged)');
    for (const d of plan.duplicates) log(`  = ${d.domain}: ${d.rows.map((r) => `${r.id} (${r.auditCount} audits)`).join(', ')}`);
    log('');
  }
  if (plan.notInGsc.length) {
    log('IN DATABASE, NOT IN GSC (retained)');
    for (const e of plan.notInGsc) log(`  ? ${e.domain.padEnd(32)} ${e.reason}`);
    log('');
  }
  if (plan.ambiguous.length) {
    log('AMBIGUOUS (manual review — no action)');
    for (const e of plan.ambiguous) log(`  ? ${e.domain.padEnd(32)} ${e.reason}`);
    log('');
  }
}

// ── main ──────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  assertAllowedTarget(opts.apiBase);

  if (!opts.input) {
    console.error(
      'error: --input <file> is required.\n' +
        '       Capture the Smacient MCP response first:\n' +
        '         tool   query-web-performance\n' +
        '         action gsc_list_sites\n' +
        '       and save the verbatim JSON to a file.',
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

  const sites = readSmacientSites(payload as never);
  if (sites.length === 0) {
    // An empty result is a state to verify, never permission to remove projects.
    console.error(
      'error: Smacient MCP returned zero Google Search Console properties.\n' +
        '       This requires verification — it is NOT a signal to remove existing projects.\n' +
        '       Attempted: query-web-performance / gsc_list_sites',
    );
    return 1;
  }

  const { properties, unparsable } = parseProperties(sites);
  for (const bad of unparsable) console.error(`warning: unparsable GSC property skipped: ${bad}`);

  let existingProjects: ExistingProject[];
  try {
    existingProjects = await fetchExistingProjects(opts.apiBase);
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

  const plan = planSync({ properties, unparsable, existingProjects, liveChecks });
  printReport(plan, opts);

  const summary: Record<string, unknown> = {
    mode: opts.apply ? 'apply' : 'dry-run',
    source: { provider: 'Smacient MCP', tool: 'query-web-performance', action: 'gsc_list_sites' },
    target: opts.apiBase,
    totals: plan.totals,
    create: plan.create,
    update: plan.update,
    unchanged: plan.unchanged,
    nonProduction: plan.nonProduction,
    duplicates: plan.duplicates,
    notInGsc: plan.notInGsc,
    ambiguous: plan.ambiguous,
    writes: { attempted: 0, created: 0, updated: 0, conflicts: 0, failed: 0 },
    auditsTriggered: 0,
    projectsDeleted: 0,
    auditsDeleted: 0,
  };

  if (!opts.apply) {
    if (opts.jsonOut) writeFileSync(opts.jsonOut, JSON.stringify(summary, null, 2), 'utf8');
    console.log('Dry run complete — 0 writes performed.');
    return 0;
  }

  // ── apply ───────────────────────────────────────────────────────
  const applyable = [...plan.create, ...plan.update];
  const results: UpsertResult[] = [];
  let failed = 0;
  let created = 0;
  let updated = 0;
  let conflicts = 0;
  let attempted = 0;
  let halted: string | null = null;

  for (const entry of applyable) {
    attempted++;
    try {
      const result = await upsertProject(opts.apiBase, entry);
      results.push(result);

      // The endpoint upserts, so a planned create that comes back with
      // created:false means the row already existed — the plan was stale.
      // Stop rather than write further rows against a stale picture.
      if (entry.action === 'create' && !result.created) {
        conflicts++;
        halted =
          `conflict on ${entry.domain}: expected HTTP 201 with created:true, ` +
          `got HTTP ${result.httpStatus} with created:false`;
        console.error(`  CONFLICT ${entry.domain}  HTTP ${result.httpStatus} created:false — halting`);
        break;
      }

      if (entry.action === 'create') created++;
      else updated++;
      console.log(`  ${result.created ? 'created' : 'updated'}  ${entry.domain}  HTTP ${result.httpStatus}`);
    } catch (err) {
      failed++;
      halted = `request failed for ${entry.domain}: ${sanitize(String((err as Error).message))}`;
      console.error(`  FAILED   ${entry.domain}: ${sanitize(String((err as Error).message))} — halting`);
      break;
    }
  }

  if (halted) {
    console.error('');
    console.error(`Apply halted after ${attempted} of ${applyable.length} planned writes.`);
    console.error('Successful writes above are preserved; no further writes were attempted.');
  }
  summary.writes = { attempted, created, updated, conflicts, failed };
  summary.halted = halted;
  summary.plannedWrites = applyable.length;
  summary.results = results;
  if (opts.jsonOut) writeFileSync(opts.jsonOut, JSON.stringify(summary, null, 2), 'utf8');

  console.log('');
  console.log(
    `Apply ${halted ? 'HALTED' : 'complete'} — created ${created}, updated ${updated}, ` +
      `conflicts ${conflicts}, failed ${failed}.`,
  );
  console.log('No audit was triggered. No project or audit was deleted.');
  return failed > 0 || conflicts > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`fatal: ${sanitize(String((err as Error)?.message ?? err))}`);
    process.exit(1);
  });
