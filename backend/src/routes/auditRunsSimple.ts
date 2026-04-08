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

export const auditRunsRouter = Router();

const PAGE_TIMEOUT = 30_000; // extended to allow for UA retries
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const VALID_TYPES = ['home', 'section', 'article', 'search', 'tag', 'author', 'video_article'] as const;

// Full browser-like headers — bare UA requests are caught by Cloudflare and most WAFs
const BROWSER_HEADERS = {
  'User-Agent':     UA,
  'Accept':         'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language':'en-US,en;q=0.9,ar;q=0.8',
  'Accept-Encoding':'gzip, deflate, br',
  'Cache-Control':  'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

const GOOGLEBOT_HEADERS = {
  'User-Agent':     UA_GOOGLEBOT,
  'Accept':         'text/html,application/xhtml+xml,*/*',
  'Accept-Language':'en-US,en;q=0.5',
  'Accept-Encoding':'gzip, deflate, br',
};

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

type PageState = 'OK' | 'CRAWLER_BLOCKED' | 'NOT_FOUND' | 'SERVER_ERROR' | 'FETCH_ERROR';

function classifyPageState(httpStatus: number, fetchOk: boolean): PageState {
  if (httpStatus >= 200 && httpStatus < 300 && fetchOk) return 'OK';
  if (httpStatus === 401 || httpStatus === 403) return 'CRAWLER_BLOCKED';
  if (httpStatus === 404 || httpStatus === 410) return 'NOT_FOUND';
  if (httpStatus >= 500) return 'SERVER_ERROR';
  return 'FETCH_ERROR';
}

const PAGE_STATE_MESSAGES: Record<PageState, string> = {
  OK: 'Page accessible',
  CRAWLER_BLOCKED: 'Crawler access blocked. On-page SEO checks skipped.',
  NOT_FOUND: 'Page not found. On-page SEO checks skipped.',
  SERVER_ERROR: 'Server error. On-page SEO checks skipped.',
  FETCH_ERROR: 'Page could not be fetched. On-page SEO checks skipped.',
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT);
  let html = '', fetchOk = false, loadMs = 0;
  let xRobotsTag = '';
  let httpStatus = 0;
  let currentUrl = url;
  const redirectChain: string[] = [];
  const fetchStart = Date.now();

  try {
    // ── Phase 1: Browser UA + full headers, redirect: manual (to track chain) ──
    for (let hop = 0; hop < 6; hop++) {
      const hopRes = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: BROWSER_HEADERS,
      });
      httpStatus = hopRes.status;

      if (httpStatus >= 300 && httpStatus < 400) {
        const location = hopRes.headers.get('location');
        if (location) {
          redirectChain.push(currentUrl);
          currentUrl = new URL(location, currentUrl).href;
          continue;
        }
      }

      if (hopRes.ok) {
        html = await hopRes.text();
        fetchOk = true;
        xRobotsTag = hopRes.headers.get('x-robots-tag') ?? '';
      } else {
        try { html = await hopRes.text(); } catch { /* body read fail ok */ }
        xRobotsTag = hopRes.headers.get('x-robots-tag') ?? '';
      }
      break;
    }

    // ── Phase 2: 403/401 → retry with Googlebot UA ────────────────────────────
    // Many news sites (and Cloudflare configs) whitelist Googlebot but block
    // generic browser requests from datacenter IPs.
    if ((httpStatus === 401 || httpStatus === 403) && !fetchOk) {
      console.log(`[audit] Phase 2: Googlebot-UA retry for ${currentUrl} (was HTTP ${httpStatus})`);
      try {
        const gbRes = await fetch(currentUrl, {
          redirect: 'follow',
          signal: controller.signal,
          headers: GOOGLEBOT_HEADERS,
        });
        if (gbRes.ok) {
          html = await gbRes.text();
          httpStatus = gbRes.status;
          fetchOk = true;
          xRobotsTag = gbRes.headers.get('x-robots-tag') ?? '';
          console.log(`[audit] Phase 2 succeeded: HTTP ${httpStatus} for ${currentUrl}`);
        } else {
          httpStatus = gbRes.status;
          try { html = await gbRes.text(); } catch {}
        }
      } catch (err: unknown) {
        console.log(`[audit] Phase 2 failed: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }

    // ── Phase 3: Still blocked → try Scrapling sidecar (headless browser) ─────
    // StealthyFetcher passes TLS fingerprint + JS challenges that native fetch
    // cannot. Only runs when SCRAPLING_SIDECAR_URL is configured.
    if ((httpStatus === 401 || httpStatus === 403) && !fetchOk) {
      const sidecarBase = process.env.SCRAPLING_SIDECAR_URL?.replace(/\/+$/, '');
      if (sidecarBase) {
        console.log(`[audit] Phase 3: Scrapling sidecar for ${currentUrl}`);
        try {
          const sidecarRes = await fetch(`${sidecarBase}/fetch`, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: currentUrl, timeout: 20 }),
          });
          if (sidecarRes.ok) {
            const sidecarData = await sidecarRes.json() as {
              html?: string; status?: number;
              headers?: Record<string, string>;
            };
            if (sidecarData.html && sidecarData.status && sidecarData.status < 300) {
              html = sidecarData.html;
              httpStatus = sidecarData.status;
              fetchOk = true;
              xRobotsTag = sidecarData.headers?.['x-robots-tag'] ?? '';
              console.log(`[audit] Phase 3 succeeded: HTTP ${httpStatus} via Scrapling`);
            }
          }
        } catch (err: unknown) {
          console.log(`[audit] Phase 3 failed: ${err instanceof Error ? err.message : 'unknown'}`);
        }
      }
    }

  } finally { loadMs = Date.now() - fetchStart; clearTimeout(timer); }

  const pageState = classifyPageState(httpStatus, fetchOk);
  const hasUsableHtml = html.length > 500 && /<!doctype|<html|<head|<body/i.test(html);

  if (pageState !== 'OK' && !hasUsableHtml) {
    const finalUrl = redirectChain.length > 0 ? currentUrl : url;
    const urlOnlyType = detectPageType(finalUrl);
    const pageType = (seedType && (VALID_TYPES as readonly string[]).includes(seedType))
      ? (seedType as typeof VALID_TYPES[number])
      : urlOnlyType;

    console.log(`[audit] Crawl gate: ${pageState} (HTTP ${httpStatus}) for ${url} — no usable HTML`);

    const data: Record<string, unknown> = {
      pageType, httpStatus, page_state: pageState,
      page_state_message: PAGE_STATE_MESSAGES[pageState],
      redirectChain: redirectChain.length > 0 ? redirectChain : null,
      redirectCount: redirectChain.length,
      finalUrl: finalUrl !== url ? finalUrl : undefined,
      detection: { urlOnly: urlOnlyType, withHtml: pageType, seedType: seedType ?? null, override: false },
      canonical: null, structuredData: null, contentMeta: null, pagination: null, performance: null,
      checksSkipped: true,
      checksSkippedReason: `${PAGE_STATE_MESSAGES[pageState]} (HTTP ${httpStatus})`,
    };
    return {
      url, data, page_state: pageState,
      status: pageState === 'CRAWLER_BLOCKED' ? 'WARN' : 'FAIL',
      error: `${PAGE_STATE_MESSAGES[pageState]} (HTTP ${httpStatus})`,
      recommendations: [PAGE_STATE_MESSAGES[pageState]],
    };
  }

  if (pageState !== 'OK' && hasUsableHtml) {
    console.log(`[audit] Crawl gate: ${pageState} (HTTP ${httpStatus}) for ${url} — usable HTML found, running checks anyway`);
  }

  const finalUrl = redirectChain.length > 0 ? currentUrl : url;
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
