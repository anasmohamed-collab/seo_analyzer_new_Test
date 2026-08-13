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
  input: string | null;
  existingProjects: string | null;
  apiBase: string;
  jsonOut: string | null;
  liveCheck: boolean;
  concurrency: number;
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
    input: null,
    existingProjects: null,
    apiBase: DEFAULT_API,
    jsonOut: null,
    liveCheck: true,
    concurrency: 6,
  };
  let sawApply = false;
  let sawDryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--apply': sawApply = true; opts.apply = true; break;
      case '--dry-run': sawDryRun = true; break;
      case '--create-only': opts.createOnly = true; break;
      case '--allow-updates': opts.allowUpdates = true; break;
      case '--no-live-check': opts.liveCheck = false; break;
      case '--input': opts.input = requireValue(argv, ++i, '--input'); break;
      case '--existing-projects':
        opts.existingProjects = requireValue(argv, ++i, '--existing-projects');
        break;
      case '--api': opts.apiBase = requireValue(argv, ++i, '--api'); break;
      case '--json': opts.jsonOut = requireValue(argv, ++i, '--json'); break;
      case '--concurrency':
        opts.concurrency = Math.max(1, Number(requireValue(argv, ++i, '--concurrency')) || 6);
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
  if (!opts.apply) return opts.createOnly ? 'DRY RUN, create-only (no writes)' : 'DRY RUN (no writes)';
  return opts.createOnly ? 'APPLY, create-only' : 'APPLY, legacy upsert (updates allowed)';
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
