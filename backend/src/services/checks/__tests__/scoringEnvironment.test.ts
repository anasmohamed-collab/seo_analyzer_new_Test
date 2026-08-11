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

function siteData(disallow: string[]) {
  return {
    robots: {
      status: 'FOUND',
      sitemapsFound: ['https://example.com/sitemap.xml'],
      rules: [{ userAgent: '*', disallow, allow: [] }],
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

  it('warns when robots.txt leaves the Beta/Staging site crawlable', () => {
    const recs = scoreSiteChecks(siteData([]), { isBeta: true });
    expect(recs).toContainEqual(expect.objectContaining({
      priority: 'P1',
      area: 'robots',
      message: 'Beta/Staging site is crawlable by Googlebot and Googlebot-News',
    }));
  });

  it('warns when a Beta/Staging seed URL has no noindex protection', () => {
    const scored = scoreResult(pageData(), { isBeta: true });
    expect(scored.status).toBe('WARN');
    expect(scored.recommendations).toContainEqual(expect.objectContaining({
      priority: 'P1',
      message: 'Beta/Staging seed URL is indexable (no noindex directive detected)',
    }));
  });
});
