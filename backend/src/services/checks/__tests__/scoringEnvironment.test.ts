import { describe, expect, it } from 'vitest';
import { scoreResult, scoreSiteChecks } from '../scoring.js';

function pageData({ metaNoindex = false, headerNoindex = false } = {}) {
  return {
    pageType: 'home' as const,
    httpStatus: 200,
    contentMeta: {
      titleLenOk: true,
      descLenOk: true,
      h1Ok: true,
      robotsMeta: { noindex: metaNoindex, nofollow: false },
      xRobotsTag: { noindex: headerNoindex, nofollow: false },
      duplicateTitle: false,
      warnings: [],
    },
  };
}

function siteData(
  disallow: string[],
  extraRules: Array<{ userAgent: string; disallow: string[]; allow: string[] }> = [],
) {
  return {
    robots: {
      status: 'FOUND',
      sitemapsFound: ['https://example.com/sitemap.xml'],
      rules: [{ userAgent: '*', disallow, allow: [] }, ...extraRules],
      notes: [],
    },
  };
}

describe('Production indexability behavior', () => {
  it('keeps robots.txt blocking as a Critical P0 issue', () => {
    const recs = scoreSiteChecks(siteData(['/']));
    expect(recs).toContainEqual(expect.objectContaining({
      priority: 'P0',
      message: 'robots.txt blocks all crawling with Disallow: /',
    }));
  });

  it('treats an explicit Googlebot Disallow: / as Critical without duplicating a wildcard block', () => {
    const googlebotRule = { userAgent: 'Googlebot', disallow: ['/'], allow: [] };
    const explicitlyBlocked = scoreSiteChecks(siteData([], [googlebotRule]));
    expect(explicitlyBlocked).toContainEqual(expect.objectContaining({
      priority: 'P0',
      message: 'robots.txt blocks Googlebot from crawling entire site',
    }));

    const wildcardAndGooglebot = scoreSiteChecks(siteData(['/'], [googlebotRule]));
    expect(wildcardAndGooglebot.filter((rec) => rec.priority === 'P0' && rec.area === 'robots'))
      .toEqual([expect.objectContaining({ message: 'robots.txt blocks all crawling with Disallow: /' })]);
  });

  it('keeps an explicit Googlebot-News block as Critical P0', () => {
    const recs = scoreSiteChecks(siteData([], [
      { userAgent: 'Googlebot-News', disallow: ['/'], allow: [] },
    ]));
    expect(recs).toContainEqual(expect.objectContaining({
      priority: 'P0',
      message: 'robots.txt blocks Googlebot-News from crawling entire site',
    }));
  });

  it('keeps a missing XML sitemap at P0 while a missing News sitemap remains P1', () => {
    const recs = scoreSiteChecks({
      sitemap: { status: 'NOT_FOUND' },
      newsSitemap: {
        status: 'NOT_FOUND',
        url: null,
        hasNewsNamespace: false,
        hasPublicationDate: false,
        hasNewsTitle: false,
        hasPublicationTag: false,
        urlCount: 0,
      },
    });
    expect(recs).toContainEqual(expect.objectContaining({
      priority: 'P0',
      message: 'No valid sitemap found after testing all priority paths',
    }));
    expect(recs).toContainEqual(expect.objectContaining({
      priority: 'P1',
      message: 'No Google News sitemap found at any standard path',
    }));
  });

  it('keeps meta and X-Robots-Tag noindex as Critical P0 issues', () => {
    expect(scoreResult(pageData({ metaNoindex: true })).recommendations)
      .toContainEqual(expect.objectContaining({ priority: 'P0', message: 'Page has noindex directive on a seed URL' }));
    expect(scoreResult(pageData({ headerNoindex: true })).recommendations)
      .toContainEqual(expect.objectContaining({ priority: 'P0', message: 'X-Robots-Tag HTTP header contains noindex' }));
  });
});

describe('Beta/Staging indexability behavior', () => {
  it('treats intentional robots.txt blocking as expected instead of Production-critical', () => {
    const recs = scoreSiteChecks(siteData(['/']), { isBeta: true });
    expect(recs.some((rec) => rec.area === 'robots' && rec.priority === 'P0')).toBe(false);
    expect(recs.some((rec) => rec.message.includes('Beta/Staging site is crawlable'))).toBe(false);
  });

  it('does not report intentional noindex as a Production-critical issue', () => {
    const meta = scoreResult(pageData({ metaNoindex: true }), { isBeta: true });
    const header = scoreResult(pageData({ headerNoindex: true }), { isBeta: true });
    expect(meta.recommendations.some((rec) => rec.message === 'Page has noindex directive on a seed URL')).toBe(false);
    expect(header.recommendations.some((rec) => rec.message === 'X-Robots-Tag HTTP header contains noindex')).toBe(false);
  });

  it('reports Critical Exposure at P0 when robots.txt leaves the Beta/Staging site crawlable', () => {
    const recs = scoreSiteChecks(siteData([]), { isBeta: true });
    expect(recs).toContainEqual(expect.objectContaining({
      priority: 'P0',
      area: 'robots',
      message: 'Beta/Staging site is crawlable by Googlebot and Googlebot-News',
    }));
  });

  it('reports Critical Exposure at P0/FAIL when a Beta/Staging seed URL has no noindex protection', () => {
    const scored = scoreResult(pageData(), { isBeta: true });
    expect(scored.status).toBe('FAIL');
    expect(scored.recommendations).toContainEqual(expect.objectContaining({
      priority: 'P0',
      message: 'Beta/Staging seed URL is indexable (no noindex directive detected)',
    }));
  });

  it('keeps the exposure wording byte-identical so stored issue identities survive the promotion', () => {
    const crawlable = scoreSiteChecks(siteData([]), { isBeta: true })
      .find((rec) => rec.area === 'robots' && rec.message.startsWith('Beta/Staging site is crawlable'));
    const indexable = scoreResult(pageData(), { isBeta: true }).recommendations
      .find((rec) => rec.message.startsWith('Beta/Staging seed URL is indexable'));

    // These two strings are the runner's notification-eligibility keys and part
    // of the issue fingerprint. Changing them would fork issue history.
    expect(crawlable?.message).toBe('Beta/Staging site is crawlable by Googlebot and Googlebot-News');
    expect(indexable?.message).toBe('Beta/Staging seed URL is indexable (no noindex directive detected)');
  });

  it('uses only the P0 | P1 | P2 priority vocabulary', () => {
    const all = [
      ...scoreSiteChecks(siteData([]), { isBeta: true }),
      ...scoreSiteChecks(siteData(['/'])),
      ...scoreResult(pageData(), { isBeta: true }).recommendations,
      ...scoreResult(pageData({ metaNoindex: true })).recommendations,
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const rec of all) expect(['P0', 'P1', 'P2']).toContain(rec.priority);
  });
});
