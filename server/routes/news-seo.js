/**
 * News SEO API route — orchestrates all single-page News SEO modules.
 *
 * POST /api/news-seo  { url: string }
 *
 * Runs modules 1-5, 8, 9 (single-page) in parallel where possible.
 * Modules 6-7 (crawl-level) are handled by the crawler route.
 */
import { Router } from 'express';
import { analyzeNewsSitemap } from '../lib/modules/news-sitemap.js';
import { analyzeArticleSchema } from '../lib/modules/article-schema.js';
import { analyzeCanonicalConsistency } from '../lib/modules/canonical-consistency.js';
import { analyzeCoreWebVitals } from '../lib/modules/core-web-vitals.js';
import { analyzeAmp } from '../lib/modules/amp-validator.js';
import { analyzeFreshness } from '../lib/modules/freshness-analyzer.js';

export const newsSeoRouter = Router();

const FETCH_TIMEOUT = 15000;

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEO-Analyzer/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

newsSeoRouter.post('/', async (req, res) => {
  const startTime = Date.now();

  try {
    const { url } = req.body || {};

    if (!url) {
      return res.status(400).json({
        url: '',
        status: 'error',
        error: 'URL is required',
        modules: {},
      });
    }

    // 1. Fetch the page HTML first (shared by most modules)
    let html = '';
    let httpHeaders = {};
    let fetchError = null;

    try {
      const response = await fetchPage(url);
      if (!response.ok) {
        fetchError = `HTTP ${response.status}`;
      } else {
        html = await response.text();
        // Capture relevant headers
        httpHeaders = {
          'last-modified': response.headers.get('last-modified'),
          'content-type': response.headers.get('content-type'),
          'x-robots-tag': response.headers.get('x-robots-tag'),
        };
      }
    } catch (err) {
      fetchError = err.name === 'AbortError' ? 'Timeout' : err.message;
    }

    if (fetchError) {
      return res.status(502).json({
        url,
        status: 'error',
        error: `Failed to fetch page: ${fetchError}`,
        modules: {},
        duration_ms: Date.now() - startTime,
      });
    }

    // 2. Run all modules in parallel
    const [
      newsSitemap,
      articleSchema,
      canonicalConsistency,
      coreWebVitals,
      ampValidator,
      freshness,
    ] = await Promise.allSettled([
      analyzeNewsSitemap(url),
      Promise.resolve(analyzeArticleSchema(html, url)),
      analyzeCanonicalConsistency(html, url),
      analyzeCoreWebVitals(html, url),
      analyzeAmp(html, url),
      analyzeFreshness(html, url, httpHeaders),
    ]);

    // 3. Assemble response
    const modules = {};
    const moduleResults = [
      { key: 'news_sitemap', result: newsSitemap },
      { key: 'article_schema', result: articleSchema },
      { key: 'canonical_consistency', result: canonicalConsistency },
      { key: 'core_web_vitals', result: coreWebVitals },
      { key: 'amp_validator', result: ampValidator },
      { key: 'freshness', result: freshness },
    ];

    let overallScore = 0;
    let moduleCount = 0;
    let hasFailure = false;
    let hasWarning = false;

    for (const { key, result: settled } of moduleResults) {
      if (settled.status === 'fulfilled') {
        modules[key] = settled.value;
        if (settled.value.score !== undefined) {
          overallScore += settled.value.score;
          moduleCount++;
        }
        if (settled.value.status === 'FAIL') hasFailure = true;
        if (settled.value.status === 'WARNING') hasWarning = true;
      } else {
        modules[key] = {
          module: key,
          status: 'FAIL',
          error: settled.reason?.message || 'Module failed',
          issues: [{ level: 'critical', message: `Module error: ${settled.reason?.message}` }],
        };
        hasFailure = true;
      }
    }

    const avgScore = moduleCount > 0 ? Math.round(overallScore / moduleCount) : 0;

    return res.json({
      url,
      status: hasFailure ? 'FAIL' : hasWarning ? 'WARNING' : 'PASS',
      overall_score: avgScore,
      modules,
      duration_ms: Date.now() - startTime,
    });
  } catch (error) {
    console.error('news-seo error:', error);
    return res.status(500).json({
      url: req.body?.url || '',
      status: 'error',
      error: error.message,
      modules: {},
      duration_ms: Date.now() - startTime,
    });
  }
});
