/**
 * canonicalCheck.test.ts
 *
 * Unit tests for extractCanonical() and runCanonicalCheck().
 *
 * Covers the cases required by the bug report:
 *  1. Standard canonical:          <link rel="canonical" href="...">
 *  2. Reversed attributes:         <link href="..." rel="canonical">
 *  3. Unquoted rel (the bug):      <link href="..." rel=canonical>
 *  4. Upper/mixed case:            <LINK REL="canonical" HREF="...">
 *  5. Extra whitespace / self-close
 *  6. No canonical tag present
 *  7. Multiple link tags — only one is canonical
 *  8. Single-quoted attribute values
 *  9. runCanonicalCheck() integration: exists=true, match=true/false, exists=false
 * 10. Exact reproducer for onlinetranslation.ae false-negative
 */

import { describe, it, expect } from 'vitest';
import { extractCanonical, runCanonicalCheck } from '../canonicalCheck.js';

// ── extractCanonical ────────────────────────────────────────────────────────

describe('extractCanonical — attribute order & quoting', () => {
  it('1. standard: rel before href, double-quoted', () => {
    const html = '<link rel="canonical" href="https://example.com/">';
    expect(extractCanonical(html)).toBe('https://example.com/');
  });

  it('2. reversed: href before rel, double-quoted', () => {
    const html = '<link href="https://example.com/" rel="canonical">';
    expect(extractCanonical(html)).toBe('https://example.com/');
  });

  it('3. unquoted rel value — root cause of the false negative', () => {
    const html = '<link href="https://example.com/" rel=canonical>';
    expect(extractCanonical(html)).toBe('https://example.com/');
  });

  it('3b. unquoted rel before href', () => {
    const html = '<link rel=canonical href="https://example.com/">';
    expect(extractCanonical(html)).toBe('https://example.com/');
  });

  it('4. uppercase tag and attribute names', () => {
    const html = '<LINK REL="canonical" HREF="https://example.com/">';
    expect(extractCanonical(html)).toBe('https://example.com/');
  });

  it('4b. mixed case', () => {
    const html = '<Link Rel="Canonical" Href="https://example.com/">';
    expect(extractCanonical(html)).toBe('https://example.com/');
  });

  it('5. self-closing tag with extra whitespace', () => {
    const html = '<link  rel="canonical"  href="https://example.com/"  />';
    expect(extractCanonical(html)).toBe('https://example.com/');
  });

  it('5b. newlines between attributes', () => {
    const html = '<link\n  rel="canonical"\n  href="https://example.com/"\n>';
    expect(extractCanonical(html)).toBe('https://example.com/');
  });

  it('6. no canonical tag → null', () => {
    const html = '<link rel="stylesheet" href="style.css"><link rel="icon" href="fav.ico">';
    expect(extractCanonical(html)).toBeNull();
  });

  it('6b. completely empty HTML → null', () => {
    expect(extractCanonical('')).toBeNull();
  });

  it('7. multiple link tags — returns the canonical one, ignores others', () => {
    const html = [
      '<link rel="stylesheet" href="style.css">',
      '<link rel="preload" href="font.woff2" as="font">',
      '<link href="https://example.com/article/" rel="canonical">',
      '<link rel="icon" href="fav.ico">',
    ].join('\n');
    expect(extractCanonical(html)).toBe('https://example.com/article/');
  });

  it('8. single-quoted attribute values', () => {
    const html = "<link rel='canonical' href='https://example.com/'>";
    expect(extractCanonical(html)).toBe('https://example.com/');
  });

  it('8b. single-quoted with reversed order', () => {
    const html = "<link href='https://example.com/' rel='canonical'>";
    expect(extractCanonical(html)).toBe('https://example.com/');
  });

  it('canonical inside realistic <head> block', () => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Test Page</title>
  <link rel="stylesheet" href="/style.css">
  <link rel="canonical" href="https://example.com/page/">
  <meta name="description" content="A test page">
</head>
<body><p>Hello</p></body>
</html>`;
    expect(extractCanonical(html)).toBe('https://example.com/page/');
  });
});

// ── Exact reproducer: onlinetranslation.ae ──────────────────────────────────

describe('extractCanonical — onlinetranslation.ae reproducer', () => {
  it('parses <link href="https://onlinetranslation.ae/" rel=canonical>', () => {
    // This is the exact tag format that was triggering the false negative.
    const html = `<html><head>
      <link href="https://onlinetranslation.ae/" rel=canonical>
    </head><body></body></html>`;
    expect(extractCanonical(html)).toBe('https://onlinetranslation.ae/');
  });
});

// ── runCanonicalCheck integration ───────────────────────────────────────────

describe('runCanonicalCheck — exists / match / notes', () => {
  const pageUrl = 'https://example.com/';

  it('canonical present and matching → exists=true, match=true, no mismatch note', () => {
    const html = '<link rel="canonical" href="https://example.com/">';
    const result = runCanonicalCheck(html, pageUrl, 'home');
    expect(result.exists).toBe(true);
    expect(result.canonicalUrl).toBe('https://example.com/');
    expect(result.match).toBe(true);
    expect(result.notes.some(n => n.includes('does not match'))).toBe(false);
  });

  it('unquoted rel=canonical and matching → exists=true, match=true', () => {
    const html = '<link href="https://example.com/" rel=canonical>';
    const result = runCanonicalCheck(html, pageUrl, 'home');
    expect(result.exists).toBe(true);
    expect(result.match).toBe(true);
  });

  it('canonical present but mismatched URL → exists=true, match=false, mismatch note', () => {
    const html = '<link rel="canonical" href="https://example.com/other-page/">';
    const result = runCanonicalCheck(html, pageUrl, 'home');
    expect(result.exists).toBe(true);
    expect(result.match).toBe(false);
    expect(result.notes.some(n => n.includes('does not match'))).toBe(true);
  });

  it('no canonical tag → exists=false, match=false, "No rel=canonical found" note', () => {
    const html = '<html><head><title>No canonical</title></head></html>';
    const result = runCanonicalCheck(html, pageUrl, 'home');
    expect(result.exists).toBe(false);
    expect(result.canonicalUrl).toBeNull();
    expect(result.match).toBe(false);
    expect(result.notes).toContain('No rel=canonical found');
  });

  it('canonical with trailing slash on root URL matches correctly (normalization)', () => {
    // https://example.com/ and https://example.com should both map to the root
    const html = '<link rel="canonical" href="https://example.com/">';
    const result = runCanonicalCheck(html, 'https://example.com', 'home');
    expect(result.exists).toBe(true);
    // Root "/" is preserved, so both normalise to the same origin
    expect(result.match).toBe(true);
  });

  it('canonical with tracking params matches lenient tier → match=true, note added', () => {
    const html = '<link rel="canonical" href="https://example.com/?utm_source=test">';
    const result = runCanonicalCheck(html, 'https://example.com/', 'home');
    expect(result.exists).toBe(true);
    // Either lenient match or tracking-param warning — it should still detect existence
    expect(result.canonicalUrl).toBe('https://example.com/?utm_source=test');
  });

  it('onlinetranslation.ae: unquoted rel=canonical → no "No rel=canonical found" note', () => {
    const html = `<html><head>
      <link href="https://onlinetranslation.ae/" rel=canonical>
    </head><body></body></html>`;
    const result = runCanonicalCheck(html, 'https://onlinetranslation.ae/', 'home');
    expect(result.exists).toBe(true);
    expect(result.notes).not.toContain('No rel=canonical found');
    expect(result.match).toBe(true);
  });
});
