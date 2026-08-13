/**
 * Flag parsing, target safety and coverage accounting for `smacient:gsc-sync`.
 *
 * These are the guards that decide whether a run may write at all, so an
 * ambiguous command line must fail rather than resolve to a default.
 */

import { describe, it, expect } from 'vitest';
import {
  assertAllowedTarget,
  buildCoverage,
  collapsedPropertyGroups,
  extractSiteName,
  modeLabel,
  parseArgs,
  sanitize,
  UsageError,
} from '../gscSyncCli.js';
import {
  collectGscProperties,
  parseProperties,
  planSync,
  type ExistingProject,
  type LiveCheck,
} from '../gscSync.js';

// ── flags ─────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('defaults to a dry run with no write mode', () => {
    const opts = parseArgs([]);
    expect(opts.apply).toBe(false);
    expect(opts.createOnly).toBe(false);
    expect(opts.allowUpdates).toBe(false);
    expect(opts.liveCheck).toBe(true);
  });

  it('accepts --dry-run --create-only', () => {
    const opts = parseArgs(['--dry-run', '--create-only']);
    expect(opts.apply).toBe(false);
    expect(opts.createOnly).toBe(true);
  });

  it('accepts --apply --create-only', () => {
    const opts = parseArgs(['--apply', '--create-only']);
    expect(opts.apply).toBe(true);
    expect(opts.createOnly).toBe(true);
  });

  it('reads the file and target flags', () => {
    const opts = parseArgs([
      '--input', 'pages.json',
      '--existing-projects', 'inventory.json',
      '--api', 'http://127.0.0.1:4000',
      '--json', 'report.json',
      '--concurrency', '3',
      '--no-live-check',
    ]);
    expect(opts.input).toBe('pages.json');
    expect(opts.existingProjects).toBe('inventory.json');
    expect(opts.apiBase).toBe('http://127.0.0.1:4000');
    expect(opts.jsonOut).toBe('report.json');
    expect(opts.concurrency).toBe(3);
    expect(opts.liveCheck).toBe(false);
  });

  it('refuses to apply without an explicit write mode', () => {
    expect(() => parseArgs(['--apply'])).toThrow(UsageError);
    expect(() => parseArgs(['--apply'])).toThrow(/refusing to apply without an explicit write mode/);
  });

  it('rejects conflicting flags', () => {
    expect(() => parseArgs(['--apply', '--dry-run', '--create-only']))
      .toThrow(/--apply and --dry-run are mutually exclusive/);
    expect(() => parseArgs(['--apply', '--create-only', '--allow-updates']))
      .toThrow(/--create-only and --allow-updates are mutually exclusive/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--force'])).toThrow(/Unknown flag: --force/);
    expect(() => parseArgs(['--create-onlyy'])).toThrow(UsageError);
  });

  it('rejects a flag whose value is missing', () => {
    expect(() => parseArgs(['--input'])).toThrow(/--input requires a value/);
    expect(() => parseArgs(['--input', '--apply', '--create-only'])).toThrow(/--input requires a value/);
  });

  it('describes the selected mode', () => {
    expect(modeLabel(parseArgs(['--dry-run', '--create-only']))).toContain('no writes');
    expect(modeLabel(parseArgs(['--apply', '--create-only']))).toBe('APPLY, create-only');
    expect(modeLabel(parseArgs(['--apply', '--allow-updates']))).toContain('updates allowed');
  });
});

describe('assertAllowedTarget', () => {
  it('refuses the production host', () => {
    expect(() => assertAllowedTarget('https://seo-analyzer.layoutworkflows.com'))
      .toThrow(/Refusing to target the production host/);
  });

  it('allows a local target', () => {
    expect(() => assertAllowedTarget('http://localhost:3000')).not.toThrow();
  });

  it('rejects an unparsable target', () => {
    expect(() => assertAllowedTarget('not a url')).toThrow(/Invalid --api base URL/);
  });
});

describe('sanitize', () => {
  it('redacts bearer tokens, query credentials and basic-auth userinfo', () => {
    expect(sanitize('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer [redacted]');
    expect(sanitize('https://x.test/a?access_token=secret&b=1')).toBe('https://x.test/a?access_token=[redacted]&b=1');
    expect(sanitize('https://user:pass@x.test/')).toBe('https://[redacted]@x.test/');
  });
});

describe('extractSiteName', () => {
  it('reads og:site_name in either attribute order', () => {
    expect(extractSiteName('<meta property="og:site_name" content="The Manila Times">'))
      .toBe('The Manila Times');
    expect(extractSiteName('<meta content="Kuwait Times" property="og:site_name">'))
      .toBe('Kuwait Times');
  });

  it('keeps an apostrophe inside a double-quoted value', () => {
    expect(extractSiteName(`<meta property="og:site_name" content="Pouvoirs d'Afrique">`))
      .toBe("Pouvoirs d'Afrique");
  });

  it('returns an empty string when the tag is absent', () => {
    expect(extractSiteName('<html><head></head></html>')).toBe('');
  });
});

// ── coverage accounting ───────────────────────────────────────────

const liveOk = (hostname: string, siteName = '', status = 200): LiveCheck => ({
  ok: true, status, finalUrl: `https://${hostname}/`, finalHostname: hostname,
  finalProtocol: 'https', siteName,
});

const EXISTING: ExistingProject[] = [
  { id: 'p-kuwait', domain: 'kuwaittimes.com', project_name: 'Kuwait Times', website_url: 'https://kuwaittimes.com/' },
];

const LIVE: Record<string, LiveCheck> = {
  'kuwaittimes.com': liveOk('kuwaittimes.com', 'Kuwait Times'),
  'manilatimes.net': liveOk('www.manilatimes.net', 'The Manila Times'),
  'akhbaar24.com': liveOk('www.akhbaar24.com', 'Akhbaar24'),
  'beta.example.com': liveOk('beta.example.com'),
  'raya.com': { ok: false, error: 'fetch failed' },
};

/** A realistic multi-page capture covering every reportable category. */
function fixture() {
  const collected = collectGscProperties({
    pages: [
      {
        sites: [
          { site_url: 'sc-domain:kuwaittimes.com', permission_level: 'siteOwner' },
          { site_url: 'sc-domain:manilatimes.net', permission_level: 'siteOwner' },
          { site_url: 'https://www.manilatimes.net/', permission_level: 'siteFullUser' },
        ],
        next_page_token: 'page-2',
      },
      {
        sites: [
          { site_url: 'https://akhbaar24.com/', permission_level: 'siteOwner' },
          { site_url: 'https://www.akhbaar24.com/', permission_level: 'siteOwner' },
          { site_url: 'sc-domain:beta.example.com', permission_level: 'siteOwner' },
          { site_url: 'sc-domain:raya.com', permission_level: 'siteRestrictedUser' },
          { site_url: 'javascript:alert(1)', permission_level: 'siteOwner' },
        ],
      },
    ],
  });
  const { properties, unparsable } = parseProperties(collected.sites);
  const plan = planSync({ properties, unparsable, existingProjects: EXISTING, liveChecks: LIVE });
  return { collected, plan, unparsable };
}

describe('buildCoverage', () => {
  it('accounts for every unique property exactly once', () => {
    const { collected, plan, unparsable } = fixture();
    const coverage = buildCoverage(collected, plan, unparsable);

    expect(collected.uniquePropertyCount).toBe(8);
    expect(coverage.complete).toBe(true);
    expect(coverage.accountedProperties).toBe(collected.uniquePropertyCount);
    expect(coverage.unaccounted).toEqual([]);
    expect(coverage.byCategory).toEqual({
      existing: 1,        // kuwaittimes.com
      create: 4,          // manilatimes.net ×2, akhbaar24.com ×2
      nonProduction: 1,   // beta.example.com
      ambiguous: 1,       // raya.com
      unparsable: 1,      // javascript:alert(1)
    });
  });

  it('places each category in the plan it belongs to', () => {
    const { plan } = fixture();
    expect(plan.unchanged.map((e) => e.domain)).toEqual(['kuwaittimes.com']);
    expect(plan.create.map((e) => e.domain).sort()).toEqual(['akhbaar24.com', 'manilatimes.net']);
    expect(plan.nonProduction.map((e) => e.domain)).toEqual(['beta.example.com']);
    expect(plan.ambiguous.map((e) => e.domain)).toEqual(['raya.com']);
  });

  it('reports incomplete coverage when a property lands in no category', () => {
    const { collected, plan, unparsable } = fixture();
    const truncated = { ...plan, create: [] };
    const coverage = buildCoverage(collected, truncated, unparsable);

    expect(coverage.complete).toBe(false);
    expect(coverage.unaccounted.join(' ')).toContain('in no category');
  });

  it('reports incomplete coverage when a property is double-counted', () => {
    const { collected, plan, unparsable } = fixture();
    const doubled = { ...plan, ambiguous: [...plan.ambiguous, ...plan.create] };
    const coverage = buildCoverage(collected, doubled, unparsable);

    expect(coverage.complete).toBe(false);
    expect(coverage.unaccounted.join(' ')).toContain('in 2 categories');
  });
});

describe('collapsedPropertyGroups', () => {
  it('lists the duplicate properties folded into each canonical website', () => {
    const { plan } = fixture();
    const collapsed = collapsedPropertyGroups(plan);

    expect(collapsed.map((c) => c.canonicalDomain).sort()).toEqual(['akhbaar24.com', 'manilatimes.net']);
    const manila = collapsed.find((c) => c.canonicalDomain === 'manilatimes.net')!;
    expect(manila.category).toBe('create');
    expect(manila.representativeProperty).toBe('sc-domain:manilatimes.net');
    expect(manila.collapsedProperties).toEqual(['https://www.manilatimes.net/']);
  });

  it('reports nothing for a website with a single property', () => {
    const { plan } = fixture();
    const collapsed = collapsedPropertyGroups(plan);
    expect(collapsed.map((c) => c.canonicalDomain)).not.toContain('kuwaittimes.com');
  });
});
