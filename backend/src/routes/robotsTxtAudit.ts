/**
 * Robots.txt Audit API — isolated, additive route.
 *
 * Mounts under /api in server/index.js. Stateless: requires no database and
 * never touches audit_runs / audit_results or the existing audit engine. It
 * fetches and quality-checks a site's robots.txt on demand, with special focus
 * on Googlebot / Googlebot-News crawlability and sitemap declarations.
 *
 * Endpoint:
 *   POST /api/robots-txt/audit
 *     body: {
 *       url?: string,             // explicit robots.txt URL (optional)
 *       homeUrl?: string,         // used to auto-detect /robots.txt if url omitted
 *       xmlSitemapUrl?: string,   // verify it is declared in robots.txt
 *       newsSitemapUrl?: string,  // verify it is declared in robots.txt
 *       importantUrls?: string[]  // content URLs to test for blocking
 *       isBeta?: boolean          // apply Beta/Staging crawlability expectations
 *     }
 *
 * Designed for both the UI and future scheduled (cron) audits, which can read a
 * project's saved robotsTxtUrl/homeUrl and POST here without UI interaction.
 */

import { Router, Request, Response } from 'express';
import { analyzeRobotsTxt } from '../services/robotsTxt/robotsTxtAnalyzer.js';

export const robotsTxtAuditRouter = Router();

robotsTxtAuditRouter.post('/robots-txt/audit', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;

  const url = str(body.url);
  const homeUrl = str(body.homeUrl);

  if (!url && !homeUrl) {
    res.status(400).json({ error: 'Either url or homeUrl is required' });
    return;
  }

  const importantUrls = Array.isArray(body.importantUrls)
    ? body.importantUrls.filter((u: unknown): u is string => typeof u === 'string' && !!u.trim()).map((u: string) => u.trim())
    : undefined;

  try {
    const result = await analyzeRobotsTxt({
      url,
      homeUrl,
      xmlSitemapUrl: str(body.xmlSitemapUrl),
      newsSitemapUrl: str(body.newsSitemapUrl),
      importantUrls,
      expectedDomain: str(body.expectedDomain),
      isBeta: body.isBeta === true,
    });
    res.json({ robotsTxt: result });
  } catch (err) {
    console.error('POST /api/robots-txt/audit error:', err);
    res.status(500).json({ error: 'Failed to analyze robots.txt' });
  }
});
