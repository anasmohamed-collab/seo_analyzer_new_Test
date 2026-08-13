/**
 * GSC page-performance → article candidates.
 *
 * Every rule here decides which URLs are worth spending a fetch on. Nothing
 * here accepts a URL as an article — that is validateArticle's job, exercised
 * in gscAuditConfig.test.ts. No network: the fetch stack is never reached.
 */

import { describe, it, expect } from 'vitest';
import {
  gscPageCandidates,
  isNeverArticleUrl,
  keepArticleShaped,
  type GscPropertyPerformance,
} from '../articleCandidates.js';

const perf = (
  site_url: string,
  pages: { page: string; clicks?: number; impressions?: number; position?: number }[],
  range: [string, string] = ['2026-05-15', '2026-08-12'],
): GscPropertyPerformance => ({
  site_url,
  date_range: { start: range[0], end: range[1] },
  pages: pages.map((p) => ({ impressions: 100, clicks: 10, position: 5, ...p })),
});

describe('isNeverArticleUrl', () => {
  it.each([
    'https://x.test/2026/07/26/sports/story/2391546/amp',
    'https://x.test/news/story?amp=1',
    'https://x.test/feed',
    'https://x.test/sitemap-news.xml',
    'https://x.test/assets/app.js',
    'https://x.test/images/hero.jpg',
    'https://x.test/wp-admin/post.php',
    'https://x.test/news/page/4',
    'https://x.test/news?page=3',
    'https://x.test/privacy-policy',
  ])('rejects %s', (url) => {
    expect(isNeverArticleUrl(url)).toBe(true);
  });

  it.each([
    'https://x.test/2026/07/18/sports/eala-stole-thunder-from-noskova/2386564',
    'https://x.test/news/a-real-multi-word-story',
    'https://x.test/article/12345678',
  ])('keeps %s', (url) => {
    expect(isNeverArticleUrl(url)).toBe(false);
  });

  it('rejects an unparsable URL', () => {
    expect(isNeverArticleUrl('not a url')).toBe(true);
  });
});

describe('keepArticleShaped', () => {
  it('drops off-domain and listing URLs and honours the limit', () => {
    const kept = keepArticleShaped(
      [
        'https://other.test/2026/07/01/news/a-story-here/1',
        'https://x.test/category/sports',
        'https://x.test/2026/07/01/news/a-story-here/1',
        'https://x.test/2026/07/02/news/another-story-here/2',
        'https://x.test/2026/07/03/news/third-story-here/3',
      ],
      'x.test',
      2,
    );
    expect(kept).toEqual([
      'https://x.test/2026/07/01/news/a-story-here/1',
      'https://x.test/2026/07/02/news/another-story-here/2',
    ]);
  });
});

describe('gscPageCandidates', () => {
  it('collects candidates and attributes each to its source property', () => {
    const result = gscPageCandidates('manilatimes.net', [
      perf('sc-domain:manilatimes.net', [
        { page: 'https://www.manilatimes.net/2026/07/18/sports/eala-stole-thunder/2386564', clicks: 6771, impressions: 40329, position: 2.8 },
      ]),
      perf('https://www.manilatimes.net/', [
        { page: 'https://www.manilatimes.net/2026/06/09/news/second-real-story-here/2361426', clicks: 5914, impressions: 111093 },
      ]),
    ]);

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].source).toBe('gsc');
    expect(result.candidates[0].gsc).toMatchObject({
      siteUrl: 'sc-domain:manilatimes.net',
      startDate: '2026-05-15',
      endDate: '2026-08-12',
      clicks: 6771,
      impressions: 40329,
      position: 2.8,
      rank: 1,
    });
    expect(result.candidates[1].gsc?.siteUrl).toBe('https://www.manilatimes.net/');
  });

  it('ranks by clicks then impressions', () => {
    const result = gscPageCandidates('x.test', [
      perf('sc-domain:x.test', [
        { page: 'https://x.test/2026/07/01/news/low-traffic-story-here/1', clicks: 5, impressions: 900 },
        { page: 'https://x.test/2026/07/02/news/high-traffic-story-here/2', clicks: 500, impressions: 20 },
        { page: 'https://x.test/2026/07/03/news/mid-traffic-story-here/3', clicks: 5, impressions: 5000 },
      ]),
    ]);
    expect(result.candidates.map((c) => c.url)).toEqual([
      'https://x.test/2026/07/02/news/high-traffic-story-here/2',
      'https://x.test/2026/07/03/news/mid-traffic-story-here/3',
      'https://x.test/2026/07/01/news/low-traffic-story-here/1',
    ]);
  });

  it('filters obvious non-article pages and records why', () => {
    const result = gscPageCandidates('manilatimes.net', [
      perf('sc-domain:manilatimes.net', [
        { page: 'https://www.manilatimes.net/' },
        { page: 'https://www.manilatimes.net/news' },
        { page: 'https://www.manilatimes.net/opinion' },
        { page: 'https://www.manilatimes.net/tag/politics' },
        { page: 'https://www.manilatimes.net/author/juan-cruz' },
        { page: 'https://www.manilatimes.net/search?q=eala' },
        { page: 'https://www.manilatimes.net/login' },
        { page: 'https://www.manilatimes.net/2026/07/26/sports/a-real-story-here/2391546/amp' },
        { page: 'https://www.manilatimes.net/feed' },
        { page: 'https://www.manilatimes.net/2026/07/26/sports/a-real-story-here/2391546' },
      ]),
    ]);

    expect(result.candidates.map((c) => c.url)).toEqual([
      'https://www.manilatimes.net/2026/07/26/sports/a-real-story-here/2391546',
    ]);
    const reasons = result.properties[0].rowsDropped.map((d) => d.reason).join(' | ');
    expect(reasons).toMatch(/homepage page, not an article/);
    expect(reasons).toMatch(/section page, not an article/);
    expect(reasons).toMatch(/tag page, not an article/);
    expect(reasons).toMatch(/author page, not an article/);
    expect(reasons).toMatch(/search page, not an article/);
    expect(reasons).toMatch(/gated page, not an article/);
    expect(reasons).toMatch(/AMP \/ feed \/ asset \/ pagination URL/);
    expect(result.properties[0].rowsReturned).toBe(10);
    expect(result.properties[0].rowsKept).toBe(1);
  });

  it('drops a page belonging to a different domain', () => {
    const result = gscPageCandidates('manilatimes.net', [
      perf('sc-domain:manilatimes.net', [
        { page: 'https://syndicated.test/2026/07/01/news/a-real-story-here/1' },
      ]),
    ]);
    expect(result.candidates).toHaveLength(0);
    expect(result.properties[0].rowsDropped[0].reason).toContain('not on manilatimes.net');
  });

  it('drops rows with no search performance — appearing in GSC is not evidence', () => {
    const result = gscPageCandidates('x.test', [
      perf('sc-domain:x.test', [
        { page: 'https://x.test/2026/07/01/news/never-seen-story-here/1', clicks: 0, impressions: 0 },
      ]),
    ]);
    expect(result.candidates).toHaveLength(0);
    expect(result.properties[0].rowsDropped[0].reason).toContain('no search evidence');
  });

  it('does not contribute the same page twice from two properties', () => {
    const shared = 'https://x.test/2026/07/01/news/a-shared-story-here/1';
    const result = gscPageCandidates('x.test', [
      perf('sc-domain:x.test', [{ page: shared }]),
      perf('https://www.x.test/', [{ page: shared }]),
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.properties[1].rowsDropped[0].reason).toContain('already contributed');
  });

  it('records a property whose page query failed, without dropping the others', () => {
    const result = gscPageCandidates('x.test', [
      { site_url: 'sc-domain:x.test', error: 'HTTP 429 rate limited', pages: [] },
      perf('https://www.x.test/', [{ page: 'https://x.test/2026/07/01/news/a-real-story-here/1' }]),
    ]);
    expect(result.properties[0].error).toBe('HTTP 429 rate limited');
    expect(result.candidates).toHaveLength(1);
  });

  it('bounds the candidate list', () => {
    const pages = Array.from({ length: 40 }, (_, i) => ({
      page: `https://x.test/2026/07/01/news/story-number-${i}-here/${i}`,
      clicks: 100 - i,
    }));
    const result = gscPageCandidates('x.test', [perf('sc-domain:x.test', pages)], { limit: 5 });
    expect(result.candidates).toHaveLength(5);
  });

  it('returns nothing when no performance data was captured', () => {
    const result = gscPageCandidates('x.test', []);
    expect(result.candidates).toEqual([]);
    expect(result.properties).toEqual([]);
  });
});
