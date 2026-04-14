/**
 * contentMetaCheck.test.ts
 *
 * Focused tests for the attribute-parsing fixes in contentMetaCheck:
 *   - extractHreflangTags(): previously missed 3/6 attribute orderings and
 *     required quoted values; now uses walkLinkTags + getAttrValue.
 *   - extractAmpLink(): same bug class as the canonical false-negative;
 *     rel=amphtml (unquoted) was not detected.
 *
 * Tests are driven through the public runContentMetaCheck() function and
 * inspect the hreflangTags / hasAmpLink / ampUrl fields of the result.
 */

import { describe, it, expect } from 'vitest';
import { runContentMetaCheck } from '../contentMetaCheck.js';

// Minimal HTML wrapper so other checks don't fire errors we don't care about
function wrap(head: string): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<title>Test page title that is long enough</title>
<meta name="description" content="A sufficiently long meta description for testing purposes only here.">
<meta name="viewport" content="width=device-width">
<h1>Test heading</h1>
${head}
</head><body><p>content</p></body></html>`;
}

function run(head: string) {
  return runContentMetaCheck(wrap(head), 'home', new Set(), { pageUrl: 'https://example.com/' });
}

// ── extractHreflangTags ─────────────────────────────────────────────────────

describe('extractHreflangTags — attribute orderings', () => {
  it('order 1: rel → hreflang → href (standard)', () => {
    const r = run('<link rel="alternate" hreflang="en" href="https://example.com/en/">');
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });

  it('order 2: rel → href → hreflang', () => {
    const r = run('<link rel="alternate" href="https://example.com/en/" hreflang="en">');
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });

  it('order 3: hreflang → href → rel', () => {
    const r = run('<link hreflang="en" href="https://example.com/en/" rel="alternate">');
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });

  it('order 4: hreflang → rel → href', () => {
    const r = run('<link hreflang="en" rel="alternate" href="https://example.com/en/">');
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });

  it('order 5: href → rel → hreflang', () => {
    const r = run('<link href="https://example.com/en/" rel="alternate" hreflang="en">');
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });

  it('order 6: href → hreflang → rel', () => {
    const r = run('<link href="https://example.com/en/" hreflang="en" rel="alternate">');
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });
});

describe('extractHreflangTags — quoting styles', () => {
  it('single-quoted attribute values', () => {
    const r = run("<link rel='alternate' hreflang='en' href='https://example.com/en/'>");
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });

  it('unquoted hreflang and rel values', () => {
    const r = run('<link rel=alternate hreflang=en href="https://example.com/en/">');
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });

  it('uppercase attribute names', () => {
    const r = run('<LINK REL="alternate" HREFLANG="en" HREF="https://example.com/en/">');
    expect(r.hreflangTags).toEqual([{ hreflang: 'en', href: 'https://example.com/en/' }]);
  });
});

describe('extractHreflangTags — multiple tags and deduplication', () => {
  it('collects multiple hreflang entries', () => {
    const head = [
      '<link rel="alternate" hreflang="en" href="https://example.com/en/">',
      '<link rel="alternate" hreflang="ar" href="https://example.com/ar/">',
      '<link rel="alternate" hreflang="fr" href="https://example.com/fr/">',
    ].join('\n');
    const r = run(head);
    expect(r.hreflangTags).toHaveLength(3);
    expect(r.hreflangTags.map(t => t.hreflang).sort()).toEqual(['ar', 'en', 'fr']);
  });

  it('deduplicates identical hreflang + href pairs', () => {
    const head = [
      '<link rel="alternate" hreflang="en" href="https://example.com/en/">',
      '<link rel="alternate" hreflang="en" href="https://example.com/en/">',
    ].join('\n');
    const r = run(head);
    expect(r.hreflangTags).toHaveLength(1);
  });

  it('ignores non-alternate link tags', () => {
    const head = [
      '<link rel="canonical" href="https://example.com/">',
      '<link rel="stylesheet" href="style.css">',
      '<link rel="alternate" hreflang="en" href="https://example.com/en/">',
    ].join('\n');
    const r = run(head);
    expect(r.hreflangTags).toHaveLength(1);
    expect(r.hreflangTags[0].hreflang).toBe('en');
  });

  it('returns empty array when no hreflang tags present', () => {
    const r = run('<link rel="canonical" href="https://example.com/">');
    expect(r.hreflangTags).toEqual([]);
  });
});

// ── extractAmpLink ──────────────────────────────────────────────────────────

describe('extractAmpLink — quoting styles and attribute order', () => {
  it('standard: rel="amphtml" before href', () => {
    const r = run('<link rel="amphtml" href="https://example.com/amp/">');
    expect(r.hasAmpLink).toBe(true);
    expect(r.ampUrl).toBe('https://example.com/amp/');
  });

  it('reversed: href before rel="amphtml"', () => {
    const r = run('<link href="https://example.com/amp/" rel="amphtml">');
    expect(r.hasAmpLink).toBe(true);
    expect(r.ampUrl).toBe('https://example.com/amp/');
  });

  it('unquoted rel=amphtml', () => {
    const r = run('<link href="https://example.com/amp/" rel=amphtml>');
    expect(r.hasAmpLink).toBe(true);
    expect(r.ampUrl).toBe('https://example.com/amp/');
  });

  it('single-quoted values', () => {
    const r = run("<link rel='amphtml' href='https://example.com/amp/'>");
    expect(r.hasAmpLink).toBe(true);
    expect(r.ampUrl).toBe('https://example.com/amp/');
  });

  it('uppercase tag and attribute names', () => {
    const r = run('<LINK REL="amphtml" HREF="https://example.com/amp/">');
    expect(r.hasAmpLink).toBe(true);
    expect(r.ampUrl).toBe('https://example.com/amp/');
  });

  it('no AMP link returns false / null', () => {
    const r = run('<link rel="canonical" href="https://example.com/">');
    expect(r.hasAmpLink).toBe(false);
    expect(r.ampUrl).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Meta / HTML tag extraction — follow-up hardening
// ═══════════════════════════════════════════════════════════════════════════════

// runClean() is intentionally minimal: no description, no viewport, no lang.
// Tests that need to control those specific meta tags use this helper so they
// are not shadowed by the tags that wrap() always injects.
function runClean(extraHead: string) {
  const html = `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<title>Long enough title to avoid warnings</title>
${extraHead}
</head><body><h1>One heading</h1></body></html>`;
  return runContentMetaCheck(html, 'home', new Set(), {});
}

// ── extractDescription ──────────────────────────────────────────────────────

describe('extractDescription — attribute order and quoting', () => {
  it('standard: name before content, double-quoted', () => {
    const r = runClean('<meta name="description" content="A good meta description for the page.">');
    expect(r.description).toBe('A good meta description for the page.');
  });

  it('reversed: content before name', () => {
    const r = runClean('<meta content="A good meta description for the page." name="description">');
    expect(r.description).toBe('A good meta description for the page.');
  });

  it('single-quoted attribute values', () => {
    const r = runClean("<meta name='description' content='A good meta description for the page.'>");
    expect(r.description).toBe('A good meta description for the page.');
  });

  it('unquoted name=description', () => {
    const r = runClean('<meta name=description content="A good meta description for the page.">');
    expect(r.description).toBe('A good meta description for the page.');
  });

  it('uppercase NAME attribute', () => {
    const r = runClean('<META NAME="description" CONTENT="A good meta description for the page.">');
    expect(r.description).toBe('A good meta description for the page.');
  });

  it('description with commas and special characters', () => {
    const r = runClean('<meta name="description" content="Learn HTML, CSS &amp; JavaScript — the basics.">');
    expect(r.description).toBe('Learn HTML, CSS &amp; JavaScript — the basics.');
  });

  it('returns null when no description meta tag', () => {
    const r = runClean('');
    expect(r.description).toBeNull();
  });
});

// ── extractRobotsMeta ───────────────────────────────────────────────────────

describe('extractRobotsMeta — attribute order and quoting', () => {
  it('detects noindex with standard order', () => {
    const r = run('<meta name="robots" content="noindex">');
    expect(r.robotsMeta.noindex).toBe(true);
    expect(r.robotsMeta.nofollow).toBe(false);
  });

  it('detects nofollow with standard order', () => {
    const r = run('<meta name="robots" content="nofollow">');
    expect(r.robotsMeta.nofollow).toBe(true);
  });

  it('detects both directives in one tag', () => {
    const r = run('<meta name="robots" content="noindex, nofollow">');
    expect(r.robotsMeta.noindex).toBe(true);
    expect(r.robotsMeta.nofollow).toBe(true);
  });

  it('reversed: content before name', () => {
    const r = run('<meta content="noindex, nofollow" name="robots">');
    expect(r.robotsMeta.noindex).toBe(true);
    expect(r.robotsMeta.nofollow).toBe(true);
  });

  it('unquoted name=robots', () => {
    const r = run('<meta name=robots content="noindex">');
    expect(r.robotsMeta.noindex).toBe(true);
  });

  it('uppercase NAME and CONTENT', () => {
    const r = run('<META NAME="robots" CONTENT="noindex">');
    expect(r.robotsMeta.noindex).toBe(true);
  });

  it('case-insensitive directive detection (NOINDEX)', () => {
    const r = run('<meta name="robots" content="NOINDEX">');
    expect(r.robotsMeta.noindex).toBe(true);
  });

  it('no robots meta → both false', () => {
    const r = run('');
    expect(r.robotsMeta.noindex).toBe(false);
    expect(r.robotsMeta.nofollow).toBe(false);
  });
});

// ── extractOgTags ───────────────────────────────────────────────────────────

describe('extractOgTags — attribute order and quoting', () => {
  it('standard order: property before content', () => {
    const r = run('<meta property="og:title" content="My Page Title">');
    expect(r.ogTags.title).toBe('My Page Title');
  });

  it('reversed order: content before property', () => {
    const r = run('<meta content="My Page Title" property="og:title">');
    expect(r.ogTags.title).toBe('My Page Title');
  });

  it('single-quoted values', () => {
    const r = run("<meta property='og:title' content='My Page Title'>");
    expect(r.ogTags.title).toBe('My Page Title');
  });

  it('uppercase PROPERTY attribute', () => {
    const r = run('<meta PROPERTY="og:title" content="My Page Title">');
    expect(r.ogTags.title).toBe('My Page Title');
  });

  it('collects all OG properties in a single pass', () => {
    const head = [
      '<meta property="og:title"       content="Title">',
      '<meta property="og:description" content="Desc">',
      '<meta property="og:image"       content="https://example.com/img.jpg">',
      '<meta property="og:type"        content="article">',
      '<meta property="og:url"         content="https://example.com/page/">',
    ].join('\n');
    const r = run(head);
    expect(r.ogTags.title).toBe('Title');
    expect(r.ogTags.description).toBe('Desc');
    expect(r.ogTags.image).toBe('https://example.com/img.jpg');
    expect(r.ogTags.type).toBe('article');
    expect(r.ogTags.url).toBe('https://example.com/page/');
  });

  it('extracts article:published_time and article:modified_time', () => {
    const head = [
      '<meta property="article:published_time" content="2024-01-15T10:00:00Z">',
      '<meta property="article:modified_time"  content="2024-01-16T12:00:00Z">',
    ].join('\n');
    const r = run(head);
    expect(r.ogTags.articlePublishedTime).toBe('2024-01-15T10:00:00Z');
    expect(r.ogTags.articleModifiedTime).toBe('2024-01-16T12:00:00Z');
  });

  it('returns null for absent OG properties', () => {
    const r = run('');
    expect(r.ogTags.title).toBeNull();
    expect(r.ogTags.image).toBeNull();
    expect(r.ogTags.articlePublishedTime).toBeNull();
  });

  it('content is preserved as-is (not lowercased)', () => {
    const r = run('<meta property="og:title" content="My Article: A Story of Upper-Case">');
    expect(r.ogTags.title).toBe('My Article: A Story of Upper-Case');
  });
});

// ── extractTwitterTags ──────────────────────────────────────────────────────

describe('extractTwitterTags — attribute order and quoting', () => {
  it('standard order: name before content', () => {
    const r = run('<meta name="twitter:card" content="summary_large_image">');
    expect(r.twitterTags.card).toBe('summary_large_image');
  });

  it('reversed: content before name', () => {
    const r = run('<meta content="summary_large_image" name="twitter:card">');
    expect(r.twitterTags.card).toBe('summary_large_image');
  });

  it('unquoted name=twitter:card', () => {
    // twitter:card contains ":" which is valid in unquoted HTML5 attribute values
    const r = run('<meta name=twitter:card content="summary_large_image">');
    expect(r.twitterTags.card).toBe('summary_large_image');
  });

  it('collects card, title, and image in one pass', () => {
    const head = [
      '<meta name="twitter:card"  content="summary_large_image">',
      '<meta name="twitter:title" content="My Tweet Title">',
      '<meta name="twitter:image" content="https://example.com/img.jpg">',
    ].join('\n');
    const r = run(head);
    expect(r.twitterTags.card).toBe('summary_large_image');
    expect(r.twitterTags.title).toBe('My Tweet Title');
    expect(r.twitterTags.image).toBe('https://example.com/img.jpg');
  });

  it('ignores non-twitter meta tags', () => {
    const r = run('<meta name="description" content="Should not appear in twitter">');
    expect(r.twitterTags.card).toBeNull();
    expect(r.twitterTags.title).toBeNull();
  });

  it('returns null for absent Twitter tags', () => {
    const r = run('');
    expect(r.twitterTags.card).toBeNull();
    expect(r.twitterTags.image).toBeNull();
  });
});

// ── extractLang ─────────────────────────────────────────────────────────────

describe('extractLang — attribute variations', () => {
  // Note: the wrap() helper already adds lang="en" on <html> so these tests
  // pass custom HTML directly to runContentMetaCheck instead.

  function runRaw(html: string) {
    return runContentMetaCheck(html, 'home', new Set(), {});
  }

  it('double-quoted lang', () => {
    const r = runRaw('<html lang="en"><head><title>T T T T T T T T T T T T T T T</title></head><body><h1>H</h1></body></html>');
    expect(r.lang).toBe('en');
  });

  it('single-quoted lang', () => {
    const r = runRaw("<html lang='ar'><head><title>T T T T T T T T T T T T T T T</title></head><body><h1>H</h1></body></html>");
    expect(r.lang).toBe('ar');
  });

  it('unquoted lang=en', () => {
    const r = runRaw('<html lang=en><head><title>T T T T T T T T T T T T T T T</title></head><body><h1>H</h1></body></html>');
    expect(r.lang).toBe('en');
  });

  it('lang after another attribute', () => {
    const r = runRaw('<html dir="ltr" lang="fr"><head><title>T T T T T T T T T T T T T T T</title></head><body><h1>H</h1></body></html>');
    expect(r.lang).toBe('fr');
  });

  it('uppercase LANG attribute', () => {
    const r = runRaw('<HTML LANG="de"><head><title>T T T T T T T T T T T T T T T</title></head><body><h1>H</h1></body></html>');
    expect(r.lang).toBe('de');
  });

  it('returns null when no lang attribute', () => {
    const r = runRaw('<html><head><title>T T T T T T T T T T T T T T T</title></head><body><h1>H</h1></body></html>');
    expect(r.lang).toBeNull();
  });
});

// ── hasViewport ─────────────────────────────────────────────────────────────

describe('hasViewport — attribute variations', () => {
  // All viewport tests use runClean() because the wrap() helper already injects
  // <meta name="viewport">, which would make every test pass trivially.

  it('standard double-quoted name="viewport"', () => {
    const r = runClean('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(r.hasViewport).toBe(true);
  });

  it('reversed: content before name', () => {
    const r = runClean('<meta content="width=device-width" name="viewport">');
    expect(r.hasViewport).toBe(true);
  });

  it("single-quoted name='viewport'", () => {
    const r = runClean("<meta name='viewport' content='width=device-width'>");
    expect(r.hasViewport).toBe(true);
  });

  it('unquoted name=viewport', () => {
    const r = runClean('<meta name=viewport content="width=device-width, initial-scale=1">');
    expect(r.hasViewport).toBe(true);
  });

  it('uppercase NAME="viewport"', () => {
    const r = runClean('<META NAME="viewport" CONTENT="width=device-width">');
    expect(r.hasViewport).toBe(true);
  });

  it('returns false when no viewport meta tag', () => {
    const r = runClean(''); // no meta tags injected at all
    expect(r.hasViewport).toBe(false);
  });
});
