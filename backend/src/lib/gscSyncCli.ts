/**
 * Pure command-line logic for `smacient:gsc-sync`.
 *
 * Kept out of the script entry point so flag parsing, target safety, coverage
 * accounting and HTML name extraction are unit-testable without executing the
 * command — importing the script itself would run it.
 *
 * Nothing here performs I/O.
 */

import type { CollectedGscProperties, PlanEntry, SyncPlan } from './gscSync.js';

/** Never contact the production deployment from this tool. */
export const FORBIDDEN_HOSTS = ['seo-analyzer.layoutworkflows.com'];

export const DEFAULT_API = process.env.SEO_API_BASE_URL ?? 'http://localhost:3000';

export interface Options {
  apply: boolean;
  createOnly: boolean;
  allowUpdates: boolean;
  withAuditConfig: boolean;
  input: string | null;
  /** Captured GET /api/projects response. Dry-run planning only. */
  existingProjects: string | null;
  /** Captured gsc_top_pages responses, keyed by GSC property. */
  gscPageData: string | null;
  apiBase: string;
  jsonOut: string | null;
  liveCheck: boolean;
  concurrency: number;
  /** Operator-declared totals; a mismatch fails the collection. */
  expectProperties: number | null;
  expectRawEntries: number | null;
}

/** A flag problem. Always fatal — a misread flag must never become a write. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

/**
 * Parse the command line.
 *
 * Unknown flags, missing values and conflicting intent all throw: a run that
 * may write must never proceed from a guess about what was asked for.
 */
export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    apply: false,
    createOnly: false,
    allowUpdates: false,
    withAuditConfig: false,
    input: null,
    existingProjects: null,
    gscPageData: null,
    apiBase: DEFAULT_API,
    jsonOut: null,
    liveCheck: true,
    concurrency: 6,
    expectProperties: null,
    expectRawEntries: null,
  };
  let sawApply = false;
  let sawDryRun = false;

  const requireCount = (raw: string, flag: string): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new UsageError(`${flag} requires a non-negative whole number`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--apply': sawApply = true; opts.apply = true; break;
      case '--dry-run': sawDryRun = true; break;
      case '--create-only': opts.createOnly = true; break;
      case '--allow-updates': opts.allowUpdates = true; break;
      case '--with-audit-config': opts.withAuditConfig = true; break;
      case '--no-live-check': opts.liveCheck = false; break;
      case '--input': opts.input = requireValue(argv, ++i, '--input'); break;
      case '--existing-projects':
        opts.existingProjects = requireValue(argv, ++i, '--existing-projects');
        break;
      case '--gsc-page-data':
        opts.gscPageData = requireValue(argv, ++i, '--gsc-page-data');
        break;
      case '--api': opts.apiBase = requireValue(argv, ++i, '--api'); break;
      case '--json': opts.jsonOut = requireValue(argv, ++i, '--json'); break;
      case '--concurrency':
        opts.concurrency = Math.max(1, Number(requireValue(argv, ++i, '--concurrency')) || 6);
        break;
      case '--expect-properties':
        opts.expectProperties = requireCount(requireValue(argv, ++i, '--expect-properties'), '--expect-properties');
        break;
      case '--expect-raw-entries':
        opts.expectRawEntries = requireCount(requireValue(argv, ++i, '--expect-raw-entries'), '--expect-raw-entries');
        break;
      default:
        throw new UsageError(`Unknown flag: ${arg}`);
    }
  }

  if (sawApply && sawDryRun) {
    throw new UsageError('--apply and --dry-run are mutually exclusive');
  }
  if (opts.createOnly && opts.allowUpdates) {
    throw new UsageError('--create-only and --allow-updates are mutually exclusive');
  }
  if (opts.apply && !opts.createOnly && !opts.allowUpdates) {
    throw new UsageError(
      'refusing to apply without an explicit write mode.\n' +
        '       --create-only    create missing projects only (safe: never updates an existing project)\n' +
        '       --allow-updates  legacy upsert, may modify existing projects',
    );
  }
  if (opts.withAuditConfig && !opts.createOnly) {
    throw new UsageError('--with-audit-config is only valid together with --create-only');
  }

  // A captured inventory file is a planning input, never a verification
  // source. Re-reading the same static file after writing would "prove" that
  // nothing changed no matter what the apply actually did, so an apply must
  // read the live target before and after.
  if (opts.apply && opts.existingProjects) {
    throw new UsageError(
      '--existing-projects is a dry-run planning input and cannot be combined with --apply.\n' +
        '       An apply must read GET /api/projects from the real target immediately before\n' +
        '       and after writing; a static file cannot verify that existing projects survived.',
    );
  }
  return opts;
}

/** Redact anything that looks like a token before it can reach a log line. */
export function sanitize(message: string): string {
  return message
    .replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]')
    .replace(/([?&](?:key|token|access_token|api_key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//[redacted]@');
}

export function assertAllowedTarget(apiBase: string): void {
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

export function modeLabel(opts: Options): string {
  const config = opts.withAuditConfig ? ' + audit config' : '';
  if (!opts.apply) {
    return opts.createOnly ? `DRY RUN, create-only${config} (no writes)` : 'DRY RUN (no writes)';
  }
  return opts.createOnly ? `APPLY, create-only${config}` : 'APPLY, legacy upsert (updates allowed)';
}

/**
 * The warning printed before any `--with-audit-config` apply.
 *
 * Storing a complete homeUrl + articleUrl pair makes a project
 * automation-ready, which means the scheduled runner will pick it up on its
 * next tick. That is a real operational change, not a metadata edit, so the
 * operator has to have arranged for it before the rows exist.
 */
export const AUTOMATION_READY_WARNING = [
  'WARNING — --with-audit-config creates AUTOMATION-READY projects.',
  '',
  'A project with a complete homeUrl + articleUrl pair is eligible for scheduled',
  'audits: the runner selects automation-ready projects on its next tick. These',
  'rows will be audited without any further action unless you have already',
  'arranged otherwise.',
  '',
  'Before a Production apply, obtain separate explicit authorization and record',
  'proof of ALL of the following:',
  '  1. the scheduled runner/timer is disabled, OR the exact new project IDs are',
  '     excluded until they are explicitly enabled;',
  '  2. NOTIFICATIONS_ENABLED=false;',
  '  3. no audit is being triggered by this import (this command never triggers one,',
  '     but the runner may act on the rows it creates);',
  '  4. the operator understands the new rows are automation-ready.',
  '',
  'This command does not disable timers and does not change any environment',
  'variable. If no pause or per-project exclusion mechanism exists, that is an',
  'operational prerequisite to resolve first — not something to work around.',
].join('\n');

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

// ── coverage accounting ───────────────────────────────────────────

/** The plan buckets a GSC property can land in, in report order. */
export type CoverageBucket = 'existing' | 'create' | 'nonProduction' | 'ambiguous';

function bucketEntries(plan: SyncPlan): [CoverageBucket, PlanEntry[]][] {
  return [
    ['existing', [...plan.unchanged, ...plan.update]],
    ['create', plan.create],
    ['nonProduction', plan.nonProduction],
    ['ambiguous', plan.ambiguous],
  ];
}

export interface CoverageReport {
  uniqueProperties: number;
  accountedProperties: number;
  complete: boolean;
  byCategory: Record<string, number>;
  /** Properties in no category, or in more than one. Always empty when complete. */
  unaccounted: string[];
}

/**
 * Prove that every unique GSC property landed in exactly one reported
 * category. A property in no category is a silent omission; a property in two
 * is a double count. Both fail the run rather than warning.
 */
export function buildCoverage(
  collected: CollectedGscProperties,
  plan: SyncPlan,
  unparsable: string[],
): CoverageReport {
  const counted = new Map<string, string[]>();
  const byCategory: Record<string, number> = { unparsable: unparsable.length };

  for (const [name, entries] of bucketEntries(plan)) {
    let n = 0;
    for (const entry of entries) {
      for (const property of entry.gscProperties) {
        const seen = counted.get(property);
        if (seen) seen.push(name);
        else counted.set(property, [name]);
        n++;
      }
    }
    byCategory[name] = n;
  }
  for (const property of unparsable) {
    const seen = counted.get(property);
    if (seen) seen.push('unparsable');
    else counted.set(property, ['unparsable']);
  }

  const unaccounted: string[] = [];
  for (const site of collected.sites) {
    const categories = counted.get(site.site_url.trim());
    if (!categories) unaccounted.push(`${site.site_url} (in no category)`);
    else if (categories.length > 1) {
      unaccounted.push(`${site.site_url} (in ${categories.length} categories: ${categories.join(', ')})`);
    }
  }

  const accountedProperties = counted.size;
  return {
    uniqueProperties: collected.uniquePropertyCount,
    accountedProperties,
    complete: unaccounted.length === 0 && accountedProperties === collected.uniquePropertyCount,
    byCategory,
    unaccounted,
  };
}

export interface CollapsedPropertyGroup {
  canonicalDomain: string;
  category: CoverageBucket;
  representativeProperty: string;
  collapsedProperties: string[];
}

/**
 * The duplicate GSC properties that collapsed into an already-accounted
 * canonical website — the `www` twin, the `sc-domain:` twin, an extra
 * URL-prefix. Reported so the property count still reconciles after grouping.
 */
export function collapsedPropertyGroups(plan: SyncPlan): CollapsedPropertyGroup[] {
  const out: CollapsedPropertyGroup[] = [];
  for (const [category, entries] of bucketEntries(plan)) {
    for (const entry of entries) {
      if (entry.gscProperties.length < 2) continue;
      out.push({
        canonicalDomain: entry.domain,
        category,
        representativeProperty: entry.gscProperties[0],
        collapsedProperties: entry.gscProperties.slice(1),
      });
    }
  }
  return out;
}
