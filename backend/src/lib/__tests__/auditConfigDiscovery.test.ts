import { describe, it, expect } from 'vitest';
import {
  assertAllowedTarget,
  buildFormValuesPayload,
  classifyPageShape,
  isForbiddenTarget,
  isNonProductionDomain,
  existingValueIsUsable,
  extractArticleSignals,
  extractFeedLinks,
  extractInternalLinks,
  extractJsonLdTypes,
  extractRobotsSitemaps,
  extractSitemapLocs,
  hasNewsNamespace,
  isFeedXml,
  isSitemapIndex,
  parseStoredFormValues,
  validateArticle,
  validateHomepage,
  type PageResult,
} from '../auditConfigDiscovery.js';

// ── fixtures ──────────────────────────────────────────────────────

const page = (over: Partial<PageResult> = {}): PageResult => ({
  ok: true,
  httpStatus: 200,
  finalUrl: 'https://example.com/news/2026/08/06/a-real-headline-here',
  redirectChain: [],
  html: '',
  challengeDetected: false,
  error: null,
  ...over,
});

const body = (chars: number) => `<p>${'word '.repeat(Math.ceil(chars / 5))}</p>`;

const articleHtml = (over: {
  ldType?: string | null;
  ogType?: string | null;
  published?: string | null;
  canonical?: string | null;
  headline?: string | null;
  bodyChars?: number;
  articleEl?: boolean;
} = {}) => {
  const {
    ldType = 'NewsArticle', ogType = 'article', published = '2026-08-05T09:00:00Z',
    canonical = 'https://example.com/news/2026/08/06/a-real-headline-here',
    headline = 'A Real Headline Here', bodyChars = 1200, articleEl = true,
  } = over;
  return [
    '<html><head>',
    ldType ? `<script type="application/ld+json">{"@context":"https://schema.org","@type":"${ldType}","headline":"${headline}"}</script>` : '',
    ogType ? `<meta property="og:type" content="${ogType}">` : '',
    headline ? `<meta property="og:title" content="${headline}">` : '',
    published ? `<meta property="article:published_time" content="${published}">` : '',
    canonical ? `<link rel="canonical" href="${canonical}">` : '',
    '</head><body>',
    articleEl ? '<article>' : '',
    headline ? `<h1>${headline}</h1>` : '',
    body(bodyChars),
    articleEl ? '</article>' : '',
    '</body></html>',
  ].join('');
};

const homeHtml = `<html><head><title>Example News</title></head><body>${'<p>Lead story text here.</p>'.repeat(40)}</body></html>`;

// ── target guards ─────────────────────────────────────────────────

describe('target guards', () => {
  it('refuses the production host', () => {
    const prod = 'https://seo-analyzer.layoutworkflows.com';
    expect(isForbiddenTarget(prod)).toBe(true);
    expect(() => assertAllowedTarget(prod)).toThrow(/Refusing to target the production host/);
    expect(() => assertAllowedTarget(`${prod}/api/projects`)).toThrow(/Refusing/);
  });

  it('allows the TEST host', () => {
    const test = 'https://seo-analyzer-new-test-cf2ce81a.dublyo.co';
    expect(isForbiddenTarget(test)).toBe(false);
    expect(() => assertAllowedTarget(test)).not.toThrow();
  });

  it('rejects an unparsable target', () => {
    expect(() => assertAllowedTarget('not a url')).toThrow(/Invalid/);
  });

  it.each(['beta.al-madina.com', 'next.al-madina.com', 'staging.example.com', 'demo.example.com'])(
    'excludes the non-production project %s',
    (domain) => expect(isNonProductionDomain(domain)).toBe(true),
  );

  it.each(['thehimalayantimes.com', 'newtimes.co.rw', 'manilatimes.net', 'sinardaily.my'])(
    'does not exclude the live project %s',
    (domain) => expect(isNonProductionDomain(domain)).toBe(false),
  );
});

// ── page-shape classification ─────────────────────────────────────

describe('classifyPageShape', () => {
  it('identifies the homepage', () => {
    expect(classifyPageShape('https://example.com/')).toBe('homepage');
    expect(classifyPageShape('https://example.com')).toBe('homepage');
  });

  it.each([
    ['https://example.com/tag/politics', 'tag'],
    ['https://example.com/topics/economy', 'tag'],
    ['https://example.com/author/jane-doe', 'author'],
    ['https://example.com/search?q=budget', 'search'],
    ['https://example.com/category/world', 'section'],
    ['https://example.com/login', 'gated'],
    ['https://example.com/subscribe', 'gated'],
  ])('rejects %s as %s', (url, shape) => {
    expect(classifyPageShape(url)).toBe(shape);
  });

  it('recognises article-shaped URLs', () => {
    expect(classifyPageShape('https://example.com/2026/08/06/some-story')).toBe('article-like');
    expect(classifyPageShape('https://example.com/article/2386564')).toBe('article-like');
    expect(classifyPageShape('https://example.com/news/a-long-multi-word-slug')).toBe('article-like');
  });

  it('treats a single short segment as a section landing page', () => {
    expect(classifyPageShape('https://example.com/sports')).toBe('section');
  });
});

// ── signal extraction ─────────────────────────────────────────────

describe('extractArticleSignals', () => {
  it('reads NewsArticle JSON-LD, og:type, date, canonical and headline', () => {
    const s = extractArticleSignals(articleHtml());
    expect(s.jsonLdNewsArticle).toBe(true);
    expect(s.jsonLdArticle).toBe(true);
    expect(s.ogTypeArticle).toBe(true);
    expect(s.publishedTime).toBe('2026-08-05T09:00:00Z');
    expect(s.canonical).toBe('https://example.com/news/2026/08/06/a-real-headline-here');
    expect(s.headline).toBe('A Real Headline Here');
    expect(s.bodyTextLength).toBeGreaterThan(600);
    expect(s.articleElement).toBe(true);
  });

  it('finds article types nested inside an @graph', () => {
    const html = `<script type="application/ld+json">
      {"@graph":[{"@type":"WebSite"},{"@type":["NewsArticle","Thing"]}]}</script>`;
    expect(extractJsonLdTypes(html)).toContain('newsarticle');
  });

  it('falls back to a literal scan when JSON-LD is malformed', () => {
    const html = '<script type="application/ld+json">{"@type":"NewsArticle", oops,}</script>';
    expect(extractJsonLdTypes(html)).toContain('newsarticle');
  });

  it('handles single-quoted meta attributes and entity-encoded values', () => {
    const s = extractArticleSignals(`<meta property='og:title' content='Pouvoirs d&#39;Afrique'>`);
    expect(s.headline).toBe("Pouvoirs d'Afrique");
  });

  // Regression: a lazy attribute capture used to run past the closing `>` and
  // swallow the rest of the document, yielding a multi-kilobyte "canonical".
  it('never lets an attribute value escape its own tag', () => {
    const html = [
      '<link rel="preload" href="https://example.com/favicon.png">',
      '<script>var x = "a > b";</script>',
      '<meta property="og:title" content="Real Headline Here">',
      '<link rel="canonical" href="https://example.com/news/the-real-article">',
    ].join('\n');
    const s = extractArticleSignals(html);
    expect(s.canonical).toBe('https://example.com/news/the-real-article');
    expect(s.canonical!.length).toBeLessThan(200);
    expect(s.headline).toBe('Real Headline Here');
  });

  it('reads a canonical written before its rel attribute without over-capturing', () => {
    const html = '<link href="https://example.com/news/story-x" rel="canonical">\n<p>body</p>';
    expect(extractArticleSignals(html).canonical).toBe('https://example.com/news/story-x');
  });

  it('does not let an <a href> capture span tags', () => {
    const html = '<a href="/one-story-here">a</a><div title="x">t</div><a href="/two-story-here">b</a>';
    const links = extractInternalLinks(html, 'https://example.com/');
    expect(links).toEqual([
      'https://example.com/one-story-here',
      'https://example.com/two-story-here',
    ]);
  });
});

// ── sitemap / feed / link parsing ─────────────────────────────────

describe('sitemap and feed parsing', () => {
  it('reads Sitemap directives from robots.txt', () => {
    const robots = 'User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml\nSitemap: https://example.com/news-sitemap.xml';
    expect(extractRobotsSitemaps(robots)).toEqual([
      'https://example.com/sitemap.xml',
      'https://example.com/news-sitemap.xml',
    ]);
  });

  it('detects a sitemap index and extracts child locations', () => {
    const xml = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/news-sitemap.xml</loc></sitemap>
      <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap></sitemapindex>`;
    expect(isSitemapIndex(xml)).toBe(true);
    expect(extractSitemapLocs(xml)).toEqual([
      'https://example.com/news-sitemap.xml',
      'https://example.com/sitemap-1.xml',
    ]);
  });

  it('detects the Google News namespace', () => {
    const news = `<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"><url><loc>https://example.com/a-story-here</loc></url></urlset>`;
    expect(hasNewsNamespace(news)).toBe(true);
    expect(isSitemapIndex(news)).toBe(false);
    expect(hasNewsNamespace('<urlset><url><loc>https://example.com/x</loc></url></urlset>')).toBe(false);
  });

  it('extracts links from RSS and Atom feeds', () => {
    const rss = `<rss><channel><item><link>https://example.com/news/story-one-here</link></item></channel></rss>`;
    expect(isFeedXml(rss)).toBe(true);
    expect(extractFeedLinks(rss)).toContain('https://example.com/news/story-one-here');

    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="https://example.com/news/story-two-here"/></entry></feed>`;
    expect(isFeedXml(atom)).toBe(true);
    expect(extractFeedLinks(atom)).toContain('https://example.com/news/story-two-here');
  });

  it('extracts only same-domain internal links from HTML', () => {
    const html = `
      <a href="/news/local-story-here">a</a>
      <a href="https://www.example.com/news/other-story-here">b</a>
      <a href="https://other-site.com/news/elsewhere">c</a>
      <a href="mailto:x@y.z">d</a>
      <a href="#top">e</a>`;
    const links = extractInternalLinks(html, 'https://example.com/');
    expect(links).toContain('https://example.com/news/local-story-here');
    expect(links).toContain('https://www.example.com/news/other-story-here');
    expect(links.some((l) => l.includes('other-site.com'))).toBe(false);
    expect(links.some((l) => l.startsWith('mailto'))).toBe(false);
  });
});

// ── homepage validation ───────────────────────────────────────────

describe('validateHomepage', () => {
  it('accepts a same-domain homepage and normalizes to https with a trailing slash', () => {
    const d = validateHomepage('example.com', page({ finalUrl: 'https://www.example.com/', html: homeHtml }));
    expect(d.verdict).toBe('accepted');
    expect(d.homeUrl).toBe('https://www.example.com/');
    expect(d.confidence).toBe('high');
  });

  it('accepts an http → https same-domain redirect and stores https', () => {
    const d = validateHomepage('example.com', page({
      finalUrl: 'https://example.com/',
      redirectChain: ['http://example.com/', 'https://example.com/'],
      html: homeHtml,
    }));
    expect(d.verdict).toBe('accepted');
    expect(d.homeUrl).toBe('https://example.com/');
  });

  it('rejects a redirect to a different publication domain', () => {
    const d = validateHomepage('alroeya.com', page({ finalUrl: 'https://cnnbusinessarabic.com/', html: homeHtml }));
    expect(d.verdict).toBe('rejected');
    expect(d.reason).toMatch(/off-domain/);
  });

  it('rejects a WAF / CAPTCHA challenge', () => {
    const d = validateHomepage('example.com', page({ challengeDetected: true, html: homeHtml }));
    expect(d.verdict).toBe('rejected');
    expect(d.reason).toMatch(/WAF|CAPTCHA/i);
  });

  it('rejects a non-200 response', () => {
    const d = validateHomepage('example.com', page({ httpStatus: 503, html: homeHtml }));
    expect(d.verdict).toBe('rejected');
    expect(d.reason).toMatch(/HTTP 503/);
  });

  it('rejects a parked or expired-domain placeholder', () => {
    const d = validateHomepage('example.com', page({
      finalUrl: 'https://example.com/',
      html: `<html><body>${'x'.repeat(600)}<p>This domain is for sale</p></body></html>`,
    }));
    expect(d.verdict).toBe('rejected');
    expect(d.reason).toMatch(/parked|expired/i);
  });

  it('rejects an empty body', () => {
    const d = validateHomepage('example.com', page({ finalUrl: 'https://example.com/', html: '<html></html>' }));
    expect(d.verdict).toBe('rejected');
  });
});

// ── article validation ────────────────────────────────────────────

describe('validateArticle', () => {
  const url = 'https://example.com/news/2026/08/06/a-real-headline-here';

  it('accepts a news-sitemap article with NewsArticle data at high confidence', () => {
    const d = validateArticle('example.com', url, 'news-sitemap', page({ html: articleHtml() }));
    expect(d.verdict).toBe('accepted');
    expect(d.confidence).toBe('high');
    expect(d.detectedSignals).toContain('JSON-LD NewsArticle');
    expect(d.articleUrl).toBe(url);
  });

  it('accepts a standard-sitemap article with Article data at high confidence', () => {
    const d = validateArticle('example.com', url, 'sitemap', page({ html: articleHtml({ ldType: 'Article' }) }));
    expect(d.verdict).toBe('accepted');
    expect(d.confidence).toBe('high');
  });

  it('caps an RSS-sourced article at medium confidence', () => {
    const d = validateArticle('example.com', url, 'rss', page({ html: articleHtml() }));
    expect(d.verdict).toBe('accepted');
    expect(d.confidence).toBe('medium');
  });

  it('caps a homepage-link article at medium confidence', () => {
    const d = validateArticle('example.com', url, 'homepage', page({ html: articleHtml() }));
    expect(d.confidence).toBe('medium');
  });

  it('drops to medium when publication-date evidence is missing', () => {
    const d = validateArticle('example.com', url, 'news-sitemap', page({ html: articleHtml({ published: null }) }));
    expect(d.verdict).toBe('accepted');
    expect(d.confidence).toBe('medium');
  });

  it('is low confidence when only an <article> element supports the claim', () => {
    const html = `<html><body><article><h1>A Real Headline Here</h1>${body(1200)}</article></body></html>`;
    const d = validateArticle('example.com', url, 'homepage', page({ html }));
    expect(d.verdict).toBe('accepted');
    expect(d.confidence).toBe('low');
  });

  it.each([
    ['https://example.com/', 'homepage'],
    ['https://example.com/category/world', 'section'],
    ['https://example.com/tag/politics', 'tag'],
    ['https://example.com/author/jane-doe', 'author'],
    ['https://example.com/search?q=x', 'search'],
    ['https://example.com/subscribe', 'gated'],
  ])('rejects %s', (finalUrl) => {
    const d = validateArticle('example.com', finalUrl, 'sitemap', page({ finalUrl, html: articleHtml() }));
    expect(d.verdict).toBe('rejected');
    expect(d.reason).toMatch(/not an article/);
  });

  it('rejects a cross-domain final URL', () => {
    const d = validateArticle('example.com', url, 'sitemap', page({ finalUrl: 'https://syndicator.com/news/copy-of-story' }));
    expect(d.verdict).toBe('rejected');
    expect(d.reason).toMatch(/syndicated|cross-domain/);
  });

  it('rejects an off-domain canonical', () => {
    const d = validateArticle('example.com', url, 'sitemap', page({
      html: articleHtml({ canonical: 'https://origin-publisher.com/news/original' }),
    }));
    expect(d.verdict).toBe('rejected');
    expect(d.reason).toMatch(/canonical points off-domain/);
  });

  it('rejects a canonical that points at the homepage', () => {
    const d = validateArticle('example.com', url, 'sitemap', page({
      html: articleHtml({ canonical: 'https://example.com/' }),
    }));
    expect(d.verdict).toBe('rejected');
    expect(d.reason).toMatch(/canonical points at the homepage/);
  });

  it('rejects a WAF challenge and a non-200', () => {
    expect(validateArticle('example.com', url, 'sitemap', page({ challengeDetected: true })).verdict).toBe('rejected');
    expect(validateArticle('example.com', url, 'sitemap', page({ httpStatus: 404 })).verdict).toBe('rejected');
  });

  it('refuses to accept on URL shape alone when markup is absent', () => {
    const html = `<html><body><h1>A Real Headline Here</h1>${body(1200)}</body></html>`;
    const d = validateArticle('example.com', url, 'sitemap', page({ html }));
    expect(d.verdict).toBe('rejected');
    expect(d.reason).toMatch(/cannot confirm an article/);
  });

  it('rejects a stub page with markup but no real content', () => {
    const d = validateArticle('example.com', url, 'sitemap', page({ html: articleHtml({ bodyChars: 50 }) }));
    expect(d.verdict).toBe('rejected');
    expect(d.reason).toMatch(/insufficient article content/);
  });
});

// ── existing values and the apply payload ─────────────────────────

describe('existing value handling', () => {
  it('recognises a usable same-domain value and rejects others', () => {
    expect(existingValueIsUsable('https://www.example.com/', 'example.com')).toBe(true);
    expect(existingValueIsUsable('https://other.com/', 'example.com')).toBe(false);
    expect(existingValueIsUsable('', 'example.com')).toBe(false);
    expect(existingValueIsUsable(null, 'example.com')).toBe(false);
  });

  it('parses stored form values from an object or a JSON string', () => {
    expect(parseStoredFormValues({ homeUrl: 'https://a.com/', junk: 'x' })).toEqual({ homeUrl: 'https://a.com/' });
    expect(parseStoredFormValues('{"articleUrl":"https://a.com/x"}')).toEqual({ articleUrl: 'https://a.com/x' });
    expect(parseStoredFormValues('not json')).toBeNull();
    expect(parseStoredFormValues(null)).toBeNull();
  });
});

describe('buildFormValuesPayload', () => {
  it('preserves every existing optional URL while setting homeUrl and articleUrl', () => {
    const existing = {
      homeUrl: 'https://example.com/',
      sectionUrl: 'https://example.com/world',
      tagUrl: 'https://example.com/tag/x',
      searchUrl: 'https://example.com/search?q=a',
      authorUrl: 'https://example.com/author/jane',
      videoArticleUrl: 'https://example.com/video/1',
      xmlSitemapUrl: 'https://example.com/sitemap.xml',
    };
    const payload = buildFormValuesPayload(existing, { articleUrl: 'https://example.com/news/story-one-here' });
    expect(payload.sectionUrl).toBe(existing.sectionUrl);
    expect(payload.tagUrl).toBe(existing.tagUrl);
    expect(payload.searchUrl).toBe(existing.searchUrl);
    expect(payload.authorUrl).toBe(existing.authorUrl);
    expect(payload.videoArticleUrl).toBe(existing.videoArticleUrl);
    expect(payload.xmlSitemapUrl).toBe(existing.xmlSitemapUrl);
    expect(payload.articleUrl).toBe('https://example.com/news/story-one-here');
    expect(payload.homeUrl).toBe('https://example.com/');
  });

  it('never emits empty or null values that would clear a stored field', () => {
    const payload = buildFormValuesPayload(
      { homeUrl: 'https://example.com/', sectionUrl: 'https://example.com/world' },
      { homeUrl: '   ', articleUrl: null },
    );
    expect(payload.homeUrl).toBe('https://example.com/');
    expect(payload.sectionUrl).toBe('https://example.com/world');
    expect('articleUrl' in payload).toBe(false);
    expect(Object.values(payload).every((v) => typeof v === 'string' && v.trim())).toBe(true);
  });

  it('sends only form-value keys — nothing that could start an audit', () => {
    const payload = buildFormValuesPayload(
      { homeUrl: 'https://example.com/' },
      { articleUrl: 'https://example.com/news/story-one-here' },
    );
    const allowed = [
      'homeUrl', 'articleUrl', 'sectionUrl', 'tagUrl', 'searchUrl',
      'authorUrl', 'videoArticleUrl', 'xmlSitemapUrl', 'newsSitemapUrl', 'robotsTxtUrl',
    ];
    expect(Object.keys(payload).every((k) => allowed.includes(k))).toBe(true);
  });

  it('is idempotent — rebuilding from its own output changes nothing', () => {
    const first = buildFormValuesPayload(
      { sectionUrl: 'https://example.com/world' },
      { homeUrl: 'https://example.com/', articleUrl: 'https://example.com/news/story-one-here' },
    );
    const second = buildFormValuesPayload(first, {
      homeUrl: 'https://example.com/',
      articleUrl: 'https://example.com/news/story-one-here',
    });
    expect(second).toEqual(first);
  });
});
