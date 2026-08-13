/**
 * audit-config:discover â€” find and propose a validated homeUrl + articleUrl
 * for live production projects that were imported without audit configuration.
 *
 *   npm run audit-config:discover -- --dry-run
 *   npm run audit-config:discover -- --apply --project-id <id>
 *
 * Dry run is the default and performs zero writes. Apply mode touches only
 * PATCH /api/projects/:id/form-values, resending every existing optional URL
 * so nothing is cleared. It never calls an audit-run endpoint, never deletes,
 * and never modifies audits, scoring, severity, or the crawler.
 *
 * All HTTP goes through the project's existing fetch stack
 * (services/fetch/fetchEngine.ts) so bot-protection detection, timeouts and
 * UA profiles behave exactly as they do during a real audit.
 */

import { writeFileSync } from 'node:fs';
import process from 'node:process';

import { runFetchEngine, UA_BROWSER } from '../services/fetch/fetchEngine.js';
import { normalizeProjectDomain } from '../lib/normalizeProjectDomain.js';
import { isAutomationReady, type FormValues } from '../lib/projectInput.js';
import {
  assertAllowedTarget,
  buildFormValuesPayload,
  existingValueIsUsable,
  isNonProductionDomain,
  parseStoredFormValues,
  validateArticle,
  validateHomepage,
  type ArticleDecision,
  type ArticleSource,
  type HomepageDecision,
  type PageResult,
  type ProposedAction,
} from '../lib/auditConfigDiscovery.js';
// Sitemap / feed / homepage candidate discovery lives in the shared module so
// this CLI and the create-only GSC importer cannot drift apart.
import { discoverSitemapCandidates } from '../lib/articleCandidates.js';

const DEFAULT_API = process.env.SEO_API_BASE_URL ?? 'https://seo-analyzer-new-test-cf2ce81a.dublyo.co';

interface Options {
  apply: boolean;
  projectId: string | null;
  limit: number | null;
  concurrency: number;
  jsonOut: string | null;
  apiBase: string;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    apply: false, projectId: null, limit: null, concurrency: 2,
    jsonOut: null, apiBase: DEFAULT_API,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--apply': o.apply = true; break;
      case '--dry-run': o.apply = false; break;
      case '--project-id': o.projectId = argv[++i] ?? null; break;
      case '--limit': o.limit = Math.max(1, Number(argv[++i]) || 1); break;
      case '--concurrency': o.concurrency = Math.max(1, Math.min(4, Number(argv[++i]) || 2)); break;
      case '--json': o.jsonOut = argv[++i] ?? null; break;
      case '--api': o.apiBase = argv[++i] ?? DEFAULT_API; break;
      default: if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    }
  }
  return o;
}

function sanitize(message: string): string {
  return message
    .replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]')
    .replace(/([?&](?:key|token|access_token|api_key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//[redacted]@');
}

// â”€â”€ polite fetching â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** One in-flight request per hostname, enforced by chaining promises. */
const hostLocks = new Map<string, Promise<unknown>>();

async function withHostLock<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const previous = hostLocks.get(host) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  hostLocks.set(host, run.then(() => undefined, () => undefined));
  return run;
}

async function fetchPage(url: string): Promise<PageResult> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, httpStatus: 0, finalUrl: '', redirectChain: [], html: '', challengeDetected: false, error: 'invalid URL' };
  }
  return withHostLock(host, async () => {
    try {
      // Supply the signal ourselves: without one, runFetchEngine arms a plain
      // setTimeout it never clears, which keeps the event loop alive for up to
      // timeoutMs after the last request. AbortSignal.timeout uses an unref'd
      // timer, so the process can still exit promptly once work is done.
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

// â”€â”€ per-project processing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface ProjectRow {
  id: string;
  domain: string;
  project_name?: string | null;
  website_url?: string | null;
  last_form_values?: unknown;
  audit_count?: number;
}

interface ProjectReport {
  projectId: string;
  projectName: string | null;
  domain: string;
  websiteUrl: string | null;
  existingHomeUrl: string | null;
  existingArticleUrl: string | null;
  proposedHomeUrl: string | null;
  proposedArticleUrl: string | null;
  homepageStatus: number | null;
  homepageRedirectChain: string[];
  articleSource: ArticleSource | null;
  articleStatus: number | null;
  articleCanonical: string | null;
  detectedSignals: string[];
  confidence: 'high' | 'medium' | 'low';
  action: ProposedAction;
  reason: string;
  problems: string[];
  candidatesTried: number;
  alreadyAutomationReady: boolean;
}

async function processProject(project: ProjectRow): Promise<ProjectReport> {
  const domain = normalizeProjectDomain(project.domain) ?? project.domain;
  const stored = parseStoredFormValues(project.last_form_values) ?? ({} as FormValues);
  const existingHome = stored.homeUrl ?? null;
  const existingArticle = stored.articleUrl ?? null;
  const alreadyReady = isAutomationReady(project.last_form_values);

  const report: ProjectReport = {
    projectId: project.id,
    projectName: project.project_name ?? null,
    domain,
    websiteUrl: project.website_url ?? null,
    existingHomeUrl: existingHome,
    existingArticleUrl: existingArticle,
    proposedHomeUrl: null,
    proposedArticleUrl: null,
    homepageStatus: null,
    homepageRedirectChain: [],
    articleSource: null,
    articleStatus: null,
    articleCanonical: null,
    detectedSignals: [],
    confidence: 'low',
    action: 'manual-review',
    reason: '',
    problems: [],
    candidatesTried: 0,
    alreadyAutomationReady: alreadyReady,
  };

  // An already-configured project keeps its values; both are still validated.
  if (alreadyReady && existingValueIsUsable(existingHome, domain) && existingValueIsUsable(existingArticle, domain)) {
    report.action = 'no-change-already-ready';
    report.confidence = 'high';
    report.reason = 'project already has a same-domain homeUrl and articleUrl â€” preserved untouched';
    report.proposedHomeUrl = existingHome;
    report.proposedArticleUrl = existingArticle;
    return report;
  }

  const startUrl = project.website_url?.trim() || `https://${domain}/`;
  const homePage = await fetchPage(startUrl);
  const home: HomepageDecision = validateHomepage(domain, homePage);
  report.homepageStatus = home.httpStatus;
  report.homepageRedirectChain = home.redirectChain;

  if (home.verdict === 'rejected') {
    report.action = 'failed';
    report.reason = home.reason;
    report.problems.push(home.reason);
    // A valid stored homeUrl is never discarded because today's fetch failed.
    if (existingValueIsUsable(existingHome, domain)) report.proposedHomeUrl = existingHome;
    return report;
  }

  // Do not replace a valid existing manual homeUrl.
  report.proposedHomeUrl = existingValueIsUsable(existingHome, domain) ? existingHome : home.homeUrl;

  if (existingValueIsUsable(existingArticle, domain)) {
    // Validate the stored article; only replace it when clearly unusable.
    const check = await fetchPage(existingArticle as string);
    const decision = validateArticle(domain, existingArticle as string, 'homepage', check);
    if (decision.verdict === 'accepted') {
      report.proposedArticleUrl = existingArticle;
      report.articleStatus = decision.httpStatus;
      report.articleCanonical = decision.canonical;
      report.detectedSignals = decision.detectedSignals;
      report.confidence = 'high';
      report.action = report.proposedHomeUrl === existingHome ? 'no-change-already-ready' : 'apply-home-only';
      report.reason = 'existing articleUrl re-validated and preserved';
      return report;
    }
    report.problems.push(`existing articleUrl rejected: ${decision.reason}`);
  }

  const candidates = await discoverSitemapCandidates(
    home.homeUrl as string, domain, homePage.html, fetchPage,
  );
  let best: ArticleDecision | null = null;

  for (const candidate of candidates) {
    report.candidatesTried++;
    const page = await fetchPage(candidate.url);
    const decision = validateArticle(domain, candidate.url, candidate.source, page);
    if (decision.verdict === 'accepted') {
      if (!best || decision.confidence === 'high') best = decision;
      if (decision.confidence === 'high') break;
    } else if (page.challengeDetected) {
      report.problems.push(`${candidate.url}: bot protection blocked validation`);
    }
    if (report.candidatesTried >= 8) break;
  }

  if (!best) {
    report.action = 'manual-review';
    report.confidence = 'low';
    report.reason = candidates.length
      ? `no candidate passed article validation (${report.candidatesTried} tried across ${new Set(candidates.map((c) => c.source)).size} source(s))`
      : 'no article candidates discovered from sitemap, feed, or homepage links';
    return report;
  }

  report.proposedArticleUrl = best.articleUrl;
  report.articleSource = best.source;
  report.articleStatus = best.httpStatus;
  report.articleCanonical = best.canonical;
  report.detectedSignals = best.detectedSignals;
  report.confidence = best.confidence;
  report.reason = best.reason;

  if (best.confidence === 'high') {
    report.action = report.proposedHomeUrl && report.proposedArticleUrl
      ? (existingValueIsUsable(existingHome, domain) ? 'apply-article-only' : 'apply-home-and-article')
      : 'manual-review';
  } else {
    report.action = 'manual-review';
  }
  return report;
}

// â”€â”€ API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function fetchProjects(apiBase: string): Promise<ProjectRow[]> {
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/projects`, {
    headers: { Accept: 'application/json', 'User-Agent': UA_BROWSER },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GET /api/projects returned HTTP ${res.status}`);
  const body = (await res.json()) as { projects?: ProjectRow[] };
  if (!Array.isArray(body.projects)) throw new Error('GET /api/projects returned no projects array');
  return body.projects;
}

async function applyFormValues(
  apiBase: string,
  project: ProjectRow,
  report: ProjectReport,
): Promise<{ ok: boolean; automationReady: boolean; error?: string }> {
  const payload = buildFormValuesPayload(parseStoredFormValues(project.last_form_values), {
    homeUrl: report.proposedHomeUrl,
    articleUrl: report.proposedArticleUrl,
  });
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/projects/${project.id}/form-values`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA_BROWSER },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    project?: { last_form_values?: unknown };
    error?: string;
  };
  if (!res.ok) return { ok: false, automationReady: false, error: body.error ?? `HTTP ${res.status}` };
  return { ok: true, automationReady: isAutomationReady(body.project?.last_form_values) };
}

// â”€â”€ main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  assertAllowedTarget(opts.apiBase);

  let projects: ProjectRow[];
  try {
    projects = await fetchProjects(opts.apiBase);
  } catch (err) {
    console.error(`error: cannot read projects: ${sanitize(String((err as Error).message))}`);
    return 1;
  }

  const excluded = projects.filter((p) => isNonProductionDomain(p.domain));
  let live = projects.filter((p) => !isNonProductionDomain(p.domain));
  if (opts.projectId) live = live.filter((p) => p.id === opts.projectId);
  if (opts.limit) live = live.slice(0, opts.limit);

  console.log('');
  console.log('Audit-config discovery');
  console.log(`  mode              ${opts.apply ? 'APPLY' : 'DRY RUN (no writes)'}`);
  console.log(`  target            ${opts.apiBase}`);
  console.log(`  live projects     ${live.length}`);
  console.log(`  excluded non-prod ${excluded.length}`);
  console.log(`  concurrency       ${opts.concurrency} projects, 1 request per hostname`);
  console.log('');

  const reports: ProjectReport[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, live.length) }, async () => {
      while (cursor < live.length) {
        const project = live[cursor++];
        const report = await processProject(project);
        reports.push(report);
        console.log(
          `  [${reports.length}/${live.length}] ${report.domain.padEnd(30)} ${report.action.padEnd(24)} ${report.confidence}`,
        );
      }
    }),
  );

  const alreadyReady = reports.filter((r) => r.action === 'no-change-already-ready');
  const highConfidence = reports.filter(
    (r) => r.confidence === 'high' && (r.action === 'apply-home-and-article' || r.action === 'apply-article-only' || r.action === 'apply-home-only'),
  );
  const partial = reports.filter((r) => r.action === 'manual-review' && r.proposedHomeUrl && !r.proposedArticleUrl);
  const manualReview = reports.filter((r) => r.action === 'manual-review' && !(r.proposedHomeUrl && !r.proposedArticleUrl));
  const failed = reports.filter((r) => r.action === 'failed');

  console.log('');
  console.log(`  already automation-ready   ${alreadyReady.length}`);
  console.log(`  high-confidence ready      ${highConfidence.length}`);
  console.log(`  partial configuration      ${partial.length}`);
  console.log(`  manual review              ${manualReview.length}`);
  console.log(`  failed live validation     ${failed.length}`);
  console.log(`  excluded non-production    ${excluded.length}`);
  console.log('');

  const summary: Record<string, unknown> = {
    mode: opts.apply ? 'apply' : 'dry-run',
    target: opts.apiBase,
    totals: {
      liveProjectsProcessed: reports.length,
      alreadyReady: alreadyReady.length,
      highConfidence: highConfidence.length,
      partial: partial.length,
      manualReview: manualReview.length,
      failed: failed.length,
      excludedNonProduction: excluded.length,
    },
    excludedNonProduction: excluded.map((p) => ({ id: p.id, domain: p.domain, auditCount: p.audit_count ?? 0 })),
    projects: reports,
    writes: { attempted: 0, succeeded: 0, failed: 0 },
    auditsTriggered: 0,
    projectsDeleted: 0,
    auditsDeleted: 0,
  };

  if (!opts.apply) {
    if (opts.jsonOut) writeFileSync(opts.jsonOut, JSON.stringify(summary, null, 2), 'utf8');
    console.log('Dry run complete â€” 0 writes performed.');
    return 0;
  }

  // â”€â”€ apply: high-confidence only â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let attempted = 0;
  let succeeded = 0;
  let failedWrites = 0;
  for (const report of highConfidence) {
    const project = live.find((p) => p.id === report.projectId);
    if (!project) continue;
    attempted++;
    const result = await applyFormValues(opts.apiBase, project, report);
    if (result.ok && result.automationReady) {
      succeeded++;
      console.log(`  updated  ${report.domain}  automation_ready=true`);
    } else {
      failedWrites++;
      console.error(`  FAILED   ${report.domain}: ${result.error ?? 'automation_ready did not become true'} â€” halting`);
      break;
    }
  }

  summary.writes = { attempted, succeeded, failed: failedWrites };
  if (opts.jsonOut) writeFileSync(opts.jsonOut, JSON.stringify(summary, null, 2), 'utf8');
  console.log('');
  console.log(`Apply complete â€” updated ${succeeded}, failed ${failedWrites}.`);
  console.log('No audit was triggered. No project or audit was deleted.');
  return failedWrites > 0 ? 1 : 0;
}

// Set the exit code and let the event loop drain on its own. Calling
// process.exit() here raced libuv's teardown on Windows and aborted the
// process with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
// AFTER the report and JSON summary had already been written — reporting a
// bogus exit status for a run that actually succeeded.
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`fatal: ${sanitize(String((err as Error)?.message ?? err))}`);
    process.exitCode = 1;
  });
