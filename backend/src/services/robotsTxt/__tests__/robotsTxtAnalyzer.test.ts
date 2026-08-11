import { describe, it, expect } from 'vitest';
import { analyzeRobotsTxtContent, parseRobotsTxt } from '../robotsTxtAnalyzer.js';

function ctx(extra: Record<string, unknown> = {}) {
  return {
    url: 'https://example.com/robots.txt',
    autoDetected: false,
    finalUrl: 'https://example.com/robots.txt',
    httpStatus: 200,
    contentType: 'text/plain',
    options: { homeUrl: 'https://example.com/', ...extra },
  };
}

describe('parseRobotsTxt', () => {
  it('groups user-agents, captures sitemaps, comments, and case-insensitive fields', () => {
    const txt = [
      '# comment line',
      'User-Agent: Googlebot',
      'Disallow: /private/',
      'ALLOW: /private/public/',
      '',
      'User-agent: *',
      'Disallow:',
      'Sitemap: https://example.com/sitemap.xml',
      'Crawl-delay: 5',
    ].join('\n');
    const p = parseRobotsTxt(txt);
    expect(p.groups.length).toBe(2);
    expect(p.groups[0].userAgents).toEqual(['Googlebot']);
    expect(p.groups[0].rules.map(r => r.type)).toEqual(['disallow', 'allow']);
    expect(p.sitemaps.map(s => s.url)).toEqual(['https://example.com/sitemap.xml']);
  });
});

describe('analyzeRobotsTxtContent', () => {
  it('scores a healthy news robots.txt highly with both sitemaps declared', () => {
    const txt = [
      'User-agent: *',
      'Disallow: /admin/',
      'Allow: /',
      'Sitemap: https://example.com/sitemap.xml',
      'Sitemap: https://example.com/news-sitemap.xml',
    ].join('\n');
    const r = analyzeRobotsTxtContent(txt, ctx({
      xmlSitemapUrl: 'https://example.com/sitemap.xml',
      newsSitemapUrl: 'https://example.com/news-sitemap.xml',
    }));
    expect(r.summary.googlebotStatus).toBe('Partially Blocked');
    expect(r.summary.xmlSitemapDeclared).toBe(true);
    expect(r.summary.newsSitemapDeclared).toBe(true);
    expect(r.summary.criticalIssues).toBe(0);
    expect(r.score).toBeGreaterThanOrEqual(75);
  });

  it('flags Googlebot fully blocked as top_critical and caps score at 20', () => {
    const txt = 'User-agent: Googlebot\nDisallow: /';
    const r = analyzeRobotsTxtContent(txt, ctx());
    const issue = r.issues.find(i => i.type === 'googlebot_fully_blocked');
    expect(issue).toBeDefined();
    expect(issue!.priority).toBe('top_critical');
    expect(issue!.matchedRule).toContain('Disallow: /');
    expect(r.summary.googlebotStatus).toBe('Blocked');
    expect(r.score).toBeLessThanOrEqual(20);
  });

  it('treats User-agent:* Disallow:/ as Googlebot fully blocked (via fallback)', () => {
    const r = analyzeRobotsTxtContent('User-agent: *\nDisallow: /', ctx());
    expect(r.issues.some(i => i.type === 'googlebot_fully_blocked')).toBe(true);
    expect(r.issues.some(i => i.type === 'googlebot_news_fully_blocked')).toBe(true);
    expect(r.score).toBeLessThanOrEqual(20);
  });

  it('treats full crawler blocking as expected for a Beta/Staging project', () => {
    const r = analyzeRobotsTxtContent('User-agent: *\nDisallow: /', ctx({ isBeta: true }));
    expect(r.summary.googlebotStatus).toBe('Blocked');
    expect(r.summary.googlebotNewsStatus).toBe('Blocked');
    expect(r.issues.some(i => i.type === 'googlebot_fully_blocked')).toBe(false);
    expect(r.issues.some(i => i.type === 'googlebot_news_fully_blocked')).toBe(false);
  });

  it('warns when a Beta/Staging robots.txt leaves search crawlers unblocked', () => {
    const r = analyzeRobotsTxtContent('User-agent: *\nAllow: /', ctx({ isBeta: true }));
    const issue = r.issues.find(i => i.type === 'beta_search_crawlers_not_blocked');
    expect(issue).toMatchObject({ severity: 'warning', priority: 'normal' });
    expect(issue?.message).toContain('Beta/Staging site is crawlable');
  });

  it('flags Googlebot-News fully blocked as top_critical (caps at 30 when GB allowed)', () => {
    const txt = [
      'User-agent: Googlebot',
      'Allow: /',
      'User-agent: Googlebot-News',
      'Disallow: /',
    ].join('\n');
    const r = analyzeRobotsTxtContent(txt, ctx());
    expect(r.summary.googlebotStatus).toBe('Allowed');
    expect(r.summary.googlebotNewsStatus).toBe('Blocked');
    const issue = r.issues.find(i => i.type === 'googlebot_news_fully_blocked');
    expect(issue?.priority).toBe('top_critical');
    expect(r.score).toBeLessThanOrEqual(30);
    expect(r.score).toBeGreaterThan(20);
  });

  it('detects an invalid Noindex directive as top_critical and caps score at 40', () => {
    const txt = 'User-agent: Googlebot\nNoindex: /\nDisallow: /private/';
    const r = analyzeRobotsTxtContent(txt, ctx());
    const issue = r.issues.find(i => i.type === 'invalid_noindex_directive_in_robots_txt');
    expect(issue).toBeDefined();
    expect(issue!.priority).toBe('top_critical');
    expect(issue!.severity).toBe('critical');
    expect(r.scoreBreakdown.noInvalidDirectives).toBe(0);
    expect(r.score).toBeLessThanOrEqual(40);
  });

  it('warns when the project XML/News sitemaps are not declared in robots.txt', () => {
    const txt = 'User-agent: *\nDisallow: /admin/';
    const r = analyzeRobotsTxtContent(txt, ctx({
      xmlSitemapUrl: 'https://example.com/sitemap.xml',
      newsSitemapUrl: 'https://example.com/news-sitemap.xml',
    }));
    expect(r.issues.some(i => i.type === 'missing_xml_sitemap_in_robots_txt')).toBe(true);
    expect(r.issues.some(i => i.type === 'missing_news_sitemap_in_robots_txt')).toBe(true);
    expect(r.summary.xmlSitemapDeclared).toBe(false);
    expect(r.summary.newsSitemapDeclared).toBe(false);
    // Recommendations include the exact "Sitemap: <url>" lines.
    expect(r.recommendations.some(x => x.includes('Sitemap: https://example.com/news-sitemap.xml'))).toBe(true);
  });

  it('detects an important content path being blocked for Googlebot', () => {
    const txt = 'User-agent: *\nDisallow: /news/';
    const r = analyzeRobotsTxtContent(txt, ctx({
      importantUrls: ['https://example.com/news/breaking-story'],
    }));
    const issue = r.issues.find(i => i.type === 'important_news_path_blocked');
    expect(issue).toBeDefined();
    expect(issue!.url).toBe('https://example.com/news/breaking-story');
  });

  it('respects Allow overriding Disallow on equal specificity (Allow wins)', () => {
    // Disallow /news/ but Allow /news/ → Allow wins on tie, so not blocked.
    const txt = 'User-agent: *\nDisallow: /news/\nAllow: /news/';
    const r = analyzeRobotsTxtContent(txt, ctx({
      importantUrls: ['https://example.com/news/story'],
    }));
    expect(r.issues.some(i => i.type === 'important_news_path_blocked')).toBe(false);
  });

  it('detects duplicate sitemap directives and foreign-domain sitemaps', () => {
    const txt = [
      'User-agent: *',
      'Allow: /',
      'Sitemap: https://example.com/sitemap.xml',
      'Sitemap: https://example.com/sitemap.xml',
      'Sitemap: https://other-domain.com/sitemap.xml',
    ].join('\n');
    const r = analyzeRobotsTxtContent(txt, ctx());
    expect(r.issues.some(i => i.type === 'duplicate_sitemap_directive')).toBe(true);
    expect(r.issues.some(i => i.type === 'sitemap_foreign_domain')).toBe(true);
  });

  it('handles an empty robots.txt gracefully (allows all)', () => {
    const r = analyzeRobotsTxtContent('', ctx());
    expect(r.summary.googlebotStatus).toBe('Allowed');
    expect(r.issues.some(i => i.type === 'empty_robots_txt')).toBe(true);
    expect(r.analyzed).toBe(true);
  });
});
