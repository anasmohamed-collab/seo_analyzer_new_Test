/**
 * Audit routes — in-memory by default, PostgreSQL persistence when DATABASE_URL is set.
 *
 * POST /api/technical-analyzer/run   — run audit (returns results directly or auditRunId)
 * GET  /api/audit-runs/:id/results   — poll results (DB mode only)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../lib/db.js';
import { runSiteChecks } from '../services/checks/siteChecks.js';
import { runCanonicalCheck, detectPageType, detectPageTypeWithHtml } from '../services/checks/page/canonicalCheck.js';
import { runStructuredDataCheck } from '../services/checks/page/structuredDataCheck.js';
import { runContentMetaCheck } from '../services/checks/page/contentMetaCheck.js';
import { runPaginationCheck } from '../services/checks/page/paginationCheck.js';
import { runPerformanceCheck } from '../services/checks/page/performanceCheck.js';
import { scoreResult, scoreSiteChecks } from '../services/checks/scoring.js';
import { computeLayeredScore } from '../services/checks/scoring/orchestrator.js';
import type { AuditData } from '../services/checks/scoring/types.js';
import { runFetchEngine } from '../services/fetch/fetchEngine.js';
import type { BlockedConfidence, ProfileAttempt } from '../services/fetch/fetchEngine.js';

export const auditRunsRouter = Router();

const PAGE_TIMEOUT = 30_000;
const VALID_TYPES = ['home', 'section', 'article', 'search', 'tag', 'author', 'video_article'] as const;

// ── SSRF guard ──────────────────────────────────────────────────

const PRIVATE_RANGES = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./, /^169\.254\./, /^0\./, /^localhost$/i, /^\[::1\]$/,
];

function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    for (const re of PRIVATE_RANGES) { if (re.test(u.hostname)) return false; }
    return true;
  } catch { return false; }
}

// ── Page state classification ───────────────────────────────────
//
// Priority order (matches the spec):
//   1. fetchOk → OK (real 2xx content received)
//   2. Body-based WAF/challenge signal → BOT_PROTECTION_CHALLENGE
//      (runs BEFORE status checks — CF returns 200 with challenge body)
//   3. Explicit HTTP 404/410 → NOT_FOUND
//   4. Explicit HTTP 5xx → SERVER_ERROR
//   5. Parser failure → PARSE_ERROR (bytes received but decode failed; not a security block)
//   6. HIGH/MEDIUM confidence denial → CRAWLER_BLOCKED
//   7. Fallback → FETCH_ERROR (transient / unknown)
//
// HIGH confidence is never overridden by FETCH_ERROR fallback.
// PARSE_ERROR sits between server errors and blocked: the page IS reachable but
// the body could not be decoded — this is a server-side encoding issue, not blocking.

export type PageState =
  | 'OK'
  | 'BOT_PROTECTION_CHALLENGE'
  | 'CRAWLER_BLOCKED'
  | 'NOT_FOUND'
  | 'SERVER_ERROR'
  | 'PARSE_ERROR'
  | 'FETCH_ERROR';

export function classifyPageState(
  httpStatus: number,
  fetchOk: boolean,
  blockedConfidence: BlockedConfidence,
  challengeDetected: boolean,
  profilesTried: ProfileAttempt[] = [],
): PageState {
  // 1. Real content received
  if (fetchOk) return 'OK';

  // 2. Body-based WAF/CF challenge — takes priority over raw HTTP status.
  //    Cloudflare IUAM / Managed Challenge returns 200 + challenge body.
  if (challengeDetected) return 'BOT_PROTECTION_CHALLENGE';

  // 3. Unambiguous HTTP errors
  if (httpStatus === 404 || httpStatus === 410) return 'NOT_FOUND';
  if (httpStatus >= 500)                         return 'SERVER_ERROR';

  // 4. Parser failure — bytes were received and an HTTP response was sent, but
  //    the body could not be decoded (e.g. corrupt gzip). This is NOT a security
  //    block; the page is reachable but the server sent malformed content.
  const hasParserFailure = profilesTried.some(a => a.failure_kind === 'parser_failure');
  if (hasParserFailure) return 'PARSE_ERROR';

  // 5. Confidence-driven access denial (401/403 or normalised 403 from engine)
  if (blockedConfidence === 'HIGH' || blockedConfidence === 'MEDIUM') return 'CRAWLER_BLOCKED';

  // 6. Fallback — transient network issue or unknown failure
  return 'FETCH_ERROR';
}

export const PAGE_STATE_MESSAGES: Record<PageState, string> = {
  OK:                      'Page accessible',
  BOT_PROTECTION_CHALLENGE:'Bot protection challenge detected — the server returned a WAF/Cloudflare challenge page instead of real content. The page IS accessible to real browsers.',
  CRAWLER_BLOCKED:         'Crawler blocked — all fetch profiles denied access (HTTP 401/403).',
  NOT_FOUND:               'Page not found (404/410).',
  SERVER_ERROR:            'Server error (5xx).',
  PARSE_ERROR:             'Page response could not be decoded — server sent a malformed body (e.g. corrupt gzip). The page may still be accessible to real browsers.',
  FETCH_ERROR:             'Page could not be fetched — may be a transient network issue.',
};

// ── Shared: run all page checks for one URL ─────────────────────

async function auditSingleUrl(
  url: string,
  seenTitles: Set<string>,
  seedType?: string,
): Promise<Record<string, unknown>> {
  if (!isSafeUrl(url)) {
    return { url, error: 'Blocked by SSRF guard', status: 'FAIL', page_state: 'FETCH_ERROR',
      recommendations: ['URL blocked by security policy'] };
  }

  // ── Multi-profile fetch (Chrome → Firefox → Googlebot → Scrapling) ──────────
  const fetchResult = await runFetchEngine(url, { timeoutMs: PAGE_TIMEOUT });

  const {
    fetchOk, html, httpStatus, xRobotsTag,
    finalUrl, redirectChain, elapsedMs: loadMs,
    profilesTried, blockedConfidence, blockedReason, challengeDetected,
  } = fetchResult;

  // Body-aware classification: challenge signal beats raw HTTP status.
  // profilesTried is passed so parser failures get PARSE_ERROR instead of FETCH_ERROR.
  const pageState = classifyPageState(httpStatus, fetchOk, blockedConfidence, challengeDetected, profilesTried);

  // fetchOk=true means a profile returned real 2xx content — run all SEO checks.
  // Gate on valid HTML structure, not an arbitrary byte count.
  // fetchEngine already guarantees html.length >= 50 when fetchOk=true, so the
  // structure check is sufficient to confirm this is parseable HTML (not XML,
  // JSON, or binary), without falsely excluding thin/lightweight pages.
  const hasUsableHtml = fetchOk && /<!doctype|<html|<head|<body/i.test(html);

  if (!hasUsableHtml) {
    const urlOnlyType = detectPageType(finalUrl);
    const pageType = (seedType && (VALID_TYPES as readonly string[]).includes(seedType))
      ? (seedType as typeof VALID_TYPES[number])
      : urlOnlyType;

    console.log(
      `[audit] Crawl gate: ${pageState} (HTTP ${httpStatus}, confidence=${blockedConfidence}${challengeDetected ? ', CHALLENGE' : ''}) for ${url}` +
      ` — profiles tried: ${profilesTried.map(a => `${a.profile}:${a.status}(${a.failure_kind}${a.cf_challenge ? '/CF' : ''})`).join(', ')}`,
    );

    const data: Record<string, unknown> = {
      pageType, httpStatus, page_state: pageState,
      page_state_message: PAGE_STATE_MESSAGES[pageState],
      blocked_confidence: blockedConfidence,
      challenge_detected: challengeDetected,
      blocked_reason: blockedReason,
      profiles_tried: profilesTried,
      redirectChain: redirectChain.length > 0 ? redirectChain : null,
      redirectCount: redirectChain.length,
      finalUrl: finalUrl !== url ? finalUrl : undefined,
      detection: { urlOnly: urlOnlyType, withHtml: pageType, seedType: seedType ?? null, override: false },
      canonical: null, structuredData: null, contentMeta: null, pagination: null, performance: null,
      checksSkipped: true,
      checksSkippedReason: PAGE_STATE_MESSAGES[pageState],
    };

    // NOT_FOUND is a definitive failure. Blocked/challenge/transient are WARN (not FAIL).
    const returnStatus = pageState === 'NOT_FOUND' ? 'FAIL' : 'WARN';

    return {
      url, data, page_state: pageState,
      status: returnStatus,
      error: PAGE_STATE_MESSAGES[pageState],
      recommendations: pageState === 'BOT_PROTECTION_CHALLENGE'
        ? [`WAF/challenge page detected (HTTP ${httpStatus} with challenge body). The crawler tried ${profilesTried.length} UA profiles and the Scrapling headless-browser sidecar. If the sidecar is not configured, set SCRAPLING_SIDECAR_URL to enable automatic JS-challenge bypass.`]
        : pageState === 'CRAWLER_BLOCKED'
          ? [`All ${profilesTried.length} crawler profiles (Chrome, Firefox, Googlebot) received HTTP ${httpStatus}. Consider whitelisting the crawler IP or enabling Googlebot-compatible access.`]
          : pageState === 'NOT_FOUND'
            ? [`Page returned HTTP ${httpStatus} — verify the URL is correct and the page exists.`]
            : pageState === 'PARSE_ERROR'
              ? [`Server returned a body that could not be decoded (HTTP ${httpStatus}). Check Content-Encoding headers and gzip configuration on the server.`]
              : [`Page could not be fetched — may be a transient network issue. ${blockedReason ?? ''}`],
    };
  }
  const urlOnlyType = detectPageType(finalUrl);
  const pageType = (seedType && (VALID_TYPES as readonly string[]).includes(seedType))
    ? (seedType as typeof VALID_TYPES[number])
    : detectPageTypeWithHtml(finalUrl, html);

  const checkErrors: string[] = [];
  let canonical = null;
  try { canonical = runCanonicalCheck(html, finalUrl, pageType); } catch (err) {
    console.error(`[audit] canonicalCheck failed for ${url}:`, err);
    checkErrors.push(`canonical: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  let structuredData = null;
  try { structuredData = runStructuredDataCheck(html, pageType); } catch (err) {
    console.error(`[audit] structuredDataCheck failed for ${url}:`, err);
    checkErrors.push(`structuredData: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  let contentMeta = null;
  try { contentMeta = runContentMetaCheck(html, pageType, seenTitles, { pageUrl: finalUrl, xRobotsTag }); } catch (err) {
    console.error(`[audit] contentMetaCheck failed for ${url}:`, err);
    checkErrors.push(`contentMeta: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  let pagination = null;
  try { pagination = runPaginationCheck(html, finalUrl, pageType, canonical?.canonicalUrl ?? null); } catch (err) {
    console.error(`[audit] paginationCheck failed for ${url}:`, err);
    checkErrors.push(`pagination: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  let performance = null;
  try { performance = await runPerformanceCheck(finalUrl, html, loadMs); } catch (err) {
    console.error(`[audit] performanceCheck failed for ${url}:`, err);
    checkErrors.push(`performance: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  const toJson = (v: unknown) => JSON.parse(JSON.stringify(v));
  const data: Record<string, unknown> = {
    pageType, httpStatus, page_state: pageState,
    redirectChain: redirectChain.length > 0 ? redirectChain : null,
    redirectCount: redirectChain.length,
    finalUrl: finalUrl !== url ? finalUrl : undefined,
    detection: {
      urlOnly: urlOnlyType, withHtml: pageType, seedType: seedType ?? null,
      override: seedType ? (seedType !== urlOnlyType) : (pageType !== urlOnlyType),
    },
    canonical: canonical ? toJson(canonical) : null,
    structuredData: structuredData ? toJson(structuredData) : null,
    contentMeta: contentMeta ? toJson(contentMeta) : null,
    pagination: pagination ? toJson(pagination) : null,
    performance: performance ? toJson(performance) : null,
    checkErrors: checkErrors.length > 0 ? checkErrors : undefined,
  };
  const scored = scoreResult(data as Parameters<typeof scoreResult>[0]);

  let layeredScore = null;
  try { layeredScore = computeLayeredScore(data as unknown as AuditData); } catch (err) {
    console.error(`[audit] layeredScore failed for ${url}:`, err);
  }

  return {
    url, data: { ...data, layeredScore },
    status: scored.status, recommendations: scored.recommendations,
  };
}

// ── Types ───────────────────────────────────────────────────────

interface AnalyzerBody {
  homeUrl: string;
  articleUrl: string;
  optionalUrls?: {
    section?: string;
    tag?: string;
    search?: string;
    author?: string;
    video_article?: string;
  };
}

const SEED_TYPES = ['home', 'article', 'section', 'tag', 'search', 'author', 'video_article'] as const;

// ── POST /api/technical-analyzer/run ────────────────────────────

auditRunsRouter.post('/technical-analyzer/run', async (req: Request, res: Response) => {
  try {
    const body = req.body as AnalyzerBody;
    if (!body.homeUrl || !body.articleUrl) {
      res.status(400).json({ error: 'homeUrl and articleUrl are required' });
      return;
    }

    let domain: string;
    try {
      domain = new URL(body.homeUrl).hostname;
    } catch {
      res.status(400).json({ error: 'Invalid homeUrl' });
      return;
    }

    const urlMap: Record<string, string> = { home: body.homeUrl, article: body.articleUrl };
    if (body.optionalUrls) {
      for (const [type, url] of Object.entries(body.optionalUrls)) {
        if (url && url.trim() && SEED_TYPES.includes(type as typeof SEED_TYPES[number])) {
          urlMap[type] = url.trim();
        }
      }
    }

    const db = getDb();

    if (db) {
      // ── DB mode ──────────────────────────────────────────────
      try {
        // Upsert site
        const siteRes = await db.query<{ id: string; domain: string }>(
          `INSERT INTO sites (domain, updated_at)
           VALUES ($1, NOW())
           ON CONFLICT (domain) DO UPDATE SET updated_at = NOW()
           RETURNING *`,
          [domain],
        );
        const site = siteRes.rows[0];

        // Replace seed URLs
        await db.query('DELETE FROM seed_urls WHERE site_id = $1', [site.id]);
        for (const [type, url] of Object.entries(urlMap)) {
          await db.query(
            'INSERT INTO seed_urls (site_id, url, page_type) VALUES ($1, $2, $3)',
            [site.id, url, type],
          );
        }

        // Create audit run
        const runRes = await db.query<{ id: string }>(
          `INSERT INTO audit_runs (site_id, status) VALUES ($1, 'RUNNING') RETURNING *`,
          [site.id],
        );
        const auditRun = runRes.rows[0];

        // Return immediately
        res.json({ siteId: site.id, auditRunId: auditRun.id });

        // Fire-and-forget background audit
        (async () => {
          try {
            let siteChecks: unknown = null;
            try { siteChecks = await runSiteChecks(domain); } catch (err) {
              siteChecks = {
                robots: { status: 'ERROR', httpStatus: 0, sitemapsFound: [],
                  notes: [`Failed: ${err instanceof Error ? err.message : 'unknown'}`] },
                sitemap: { status: 'ERROR', discoveredFrom: 'none', validatedRoot: null,
                  type: null, errors: [`Failed: ${err instanceof Error ? err.message : 'unknown'}`], warnings: [] },
              };
            }

            await db.query(
              'UPDATE audit_runs SET site_checks = $1 WHERE id = $2',
              [JSON.stringify(siteChecks), auditRun.id],
            );

            const seedRes = await db.query<{ url: string; page_type: string | null }>(
              'SELECT url, page_type FROM seed_urls WHERE site_id = $1',
              [site.id],
            );
            const seenTitles = new Set<string>();

            for (const seed of seedRes.rows) {
              try {
                const result = await auditSingleUrl(seed.url, seenTitles, seed.page_type ?? undefined);
                const resultData = (result.data ?? { error: result.error }) as Record<string, unknown>;
                const resultStatus = (result.status as string) ?? 'FAIL';
                const resultRecs = Array.isArray(result.recommendations) && result.recommendations.length > 0
                  ? result.recommendations : null;

                await db.query(
                  `INSERT INTO audit_results (audit_run_id, url, data, status, recommendations)
                   VALUES ($1, $2, $3, $4, $5)`,
                  [auditRun.id, seed.url, JSON.stringify(resultData), resultStatus,
                    resultRecs ? JSON.stringify(resultRecs) : null],
                );
              } catch (err) {
                await db.query(
                  `INSERT INTO audit_results (audit_run_id, url, data, status, recommendations)
                   VALUES ($1, $2, $3, $4, $5)`,
                  [auditRun.id, seed.url,
                    JSON.stringify({ error: err instanceof Error ? err.message : 'unknown' }),
                    'FAIL', JSON.stringify(['Audit failed for this URL'])],
                );
              }
            }

            await db.query(
              `UPDATE audit_runs SET status = 'COMPLETED', finished_at = NOW() WHERE id = $1`,
              [auditRun.id],
            );
          } catch (err) {
            console.error('[audit] Background audit error:', err);
            await db.query(
              `UPDATE audit_runs SET status = 'FAILED', finished_at = NOW() WHERE id = $1`,
              [auditRun.id],
            ).catch(() => {});
          }
        })();
        return;

      } catch (dbErr) {
        console.warn('[audit] DB call failed, falling back to in-memory:', dbErr);
      }
    }

    // ── In-memory mode ───────────────────────────────────────────
    console.log('[audit] Running in-memory mode for', domain);

    let siteChecks: Record<string, unknown> | null = null;
    try {
      siteChecks = JSON.parse(JSON.stringify(await runSiteChecks(domain)));
    } catch (err) {
      siteChecks = {
        robots: { status: 'ERROR', httpStatus: 0, sitemapsFound: [],
          notes: [`Site checks failed: ${err instanceof Error ? err.message : 'unknown'}`] },
        sitemap: { status: 'ERROR', discoveredFrom: 'none', validatedRoot: null, type: null,
          errors: [`Site checks failed: ${err instanceof Error ? err.message : 'unknown'}`], warnings: [] },
      };
    }

    const seenTitles = new Set<string>();
    const results: Record<string, unknown>[] = [];

    for (const [type, url] of Object.entries(urlMap)) {
      try {
        results.push({ ...await auditSingleUrl(url, seenTitles, type), seedType: type });
      } catch (err) {
        results.push({ url, seedType: type, status: 'FAIL',
          error: err instanceof Error ? err.message : 'unknown',
          recommendations: ['Audit failed for this URL'] });
      }
    }

    const siteRecs = scoreSiteChecks(siteChecks as Parameters<typeof scoreSiteChecks>[0]);

    const grouped: Record<string, unknown[]> = {};
    for (const r of results) {
      const data = r.data as Record<string, unknown> | null;
      const pageType = (data?.pageType as string) ?? (r.seedType as string) ?? 'unknown';
      if (!grouped[pageType]) grouped[pageType] = [];
      grouped[pageType].push(r);
    }

    res.json({ mode: 'in-memory', status: 'COMPLETED', domain, siteChecks,
      siteRecommendations: siteRecs, resultsByType: grouped, results });

  } catch (err) {
    console.error('[audit] POST technical-analyzer/run error:', err);
    res.status(500).json({ error: 'Internal server error', detail: err instanceof Error ? err.message : 'Unknown' });
  }
});

// ── GET /api/audit-runs/:id/results ─────────────────────────────

auditRunsRouter.get('/audit-runs/:id/results', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: 'Database not configured. Results were returned directly in the run response.' });
      return;
    }

    const id = req.params['id'] as string;

    const runRes = await db.query('SELECT * FROM audit_runs WHERE id = $1', [id]);
    const run = runRes.rows[0] ?? null;
    if (!run) {
      res.status(404).json({ error: 'AuditRun not found' });
      return;
    }

    const resultsRes = await db.query(
      'SELECT * FROM audit_results WHERE audit_run_id = $1 ORDER BY created_at ASC',
      [id],
    );
    const results = resultsRes.rows;

    const grouped: Record<string, typeof results> = {};
    for (const r of results) {
      const data = r.data as Record<string, unknown> | null;
      const pageType = (data?.pageType as string) ?? 'unknown';
      if (!grouped[pageType]) grouped[pageType] = [];
      grouped[pageType].push(r);
    }

    const siteRecs = scoreSiteChecks(run.site_checks as Parameters<typeof scoreSiteChecks>[0]);

    res.json({
      id: run.id, status: run.status,
      siteChecks: run.site_checks,
      siteRecommendations: siteRecs,
      resultsByType: grouped,
      results,
    });
  } catch (err) {
    console.error('[audit] GET results error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
