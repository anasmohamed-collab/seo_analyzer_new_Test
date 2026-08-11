import { describe, it, expect } from 'vitest';
import { parseCreateProjectBody, isAutomationReady } from '../projectInput.js';

describe('parseCreateProjectBody — website_url', () => {
  it('requires website_url', () => {
    expect(parseCreateProjectBody({})).toEqual({ ok: false, error: 'website_url is required' });
    expect(parseCreateProjectBody({ website_url: '  ' })).toEqual({
      ok: false,
      error: 'website_url is required',
    });
  });

  it('accepts a scheme-less website_url', () => {
    const r = parseCreateProjectBody({ website_url: 'example.com' });
    expect(r).toMatchObject({ ok: true, domain: 'example.com', websiteUrl: 'https://example.com/' });
  });

  it('accepts http and https', () => {
    expect(parseCreateProjectBody({ website_url: 'http://example.com' })).toMatchObject({ ok: true });
    expect(parseCreateProjectBody({ website_url: 'https://example.com' })).toMatchObject({ ok: true });
  });

  it('rejects unsupported protocols', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      const r = parseCreateProjectBody({ website_url: url });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('only http and https');
    }
  });

  it('normalizes www away from the identity domain', () => {
    const a = parseCreateProjectBody({ website_url: 'https://www.example.com' });
    const b = parseCreateProjectBody({ website_url: 'https://example.com' });
    expect(a).toMatchObject({ ok: true, domain: 'example.com' });
    expect(b).toMatchObject({ ok: true, domain: 'example.com' });
  });

  it('defaults project_name to the normalized domain', () => {
    expect(parseCreateProjectBody({ website_url: 'https://www.example.com' })).toMatchObject({
      projectName: 'example.com',
    });
    expect(
      parseCreateProjectBody({ website_url: 'https://example.com', project_name: '  My Site ' }),
    ).toMatchObject({ projectName: 'My Site' });
  });
});

describe('parseCreateProjectBody — project environment', () => {
  it('treats an omitted Beta flag as an unspecified Production-compatible default', () => {
    expect(parseCreateProjectBody({ website_url: 'https://example.com' })).toMatchObject({
      ok: true,
      isBeta: null,
    });
  });

  it('accepts is_beta and the isBeta compatibility alias', () => {
    expect(parseCreateProjectBody({ website_url: 'https://beta.example.com', is_beta: true }))
      .toMatchObject({ ok: true, isBeta: true });
    expect(parseCreateProjectBody({ website_url: 'https://beta.example.com', isBeta: true }))
      .toMatchObject({ ok: true, isBeta: true });
    expect(parseCreateProjectBody({ website_url: 'https://example.com', is_beta: false }))
      .toMatchObject({ ok: true, isBeta: false });
  });

  it('rejects a non-boolean Beta flag', () => {
    expect(parseCreateProjectBody({ website_url: 'https://example.com', is_beta: 'true' })).toEqual({
      ok: false,
      error: 'is_beta must be a boolean when supplied',
    });
  });
});

describe('parseCreateProjectBody — audit configuration', () => {
  it('allows creation with no audit configuration', () => {
    const r = parseCreateProjectBody({ website_url: 'https://example.com' });
    expect(r).toMatchObject({ ok: true, formValues: null });
  });

  it('accepts top-level homeUrl and articleUrl', () => {
    const r = parseCreateProjectBody({
      website_url: 'https://example.com',
      homeUrl: 'https://example.com/',
      articleUrl: 'https://example.com/a-story',
    });
    expect(r).toMatchObject({
      ok: true,
      formValues: { homeUrl: 'https://example.com/', articleUrl: 'https://example.com/a-story' },
    });
  });

  it('accepts a nested last_form_values object', () => {
    const r = parseCreateProjectBody({
      website_url: 'https://example.com',
      last_form_values: {
        homeUrl: 'https://example.com/',
        articleUrl: 'https://example.com/a-story',
      },
    });
    expect(r).toMatchObject({
      ok: true,
      formValues: { homeUrl: 'https://example.com/', articleUrl: 'https://example.com/a-story' },
    });
  });

  it('lets top-level keys win over nested ones', () => {
    const r = parseCreateProjectBody({
      website_url: 'https://example.com',
      homeUrl: 'https://example.com/top',
      last_form_values: {
        homeUrl: 'https://example.com/nested',
        articleUrl: 'https://example.com/a-story',
      },
    });
    expect(r).toMatchObject({ ok: true, formValues: { homeUrl: 'https://example.com/top' } });
  });

  it('preserves optional audit URLs', () => {
    const r = parseCreateProjectBody({
      website_url: 'https://example.com',
      homeUrl: 'https://example.com/',
      articleUrl: 'https://example.com/a-story',
      sectionUrl: 'https://example.com/section/',
      newsSitemapUrl: 'https://example.com/news-sitemap.xml',
    });
    expect(r).toMatchObject({
      ok: true,
      formValues: {
        sectionUrl: 'https://example.com/section/',
        newsSitemapUrl: 'https://example.com/news-sitemap.xml',
      },
    });
  });

  it('discards unknown keys', () => {
    const r = parseCreateProjectBody({
      website_url: 'https://example.com',
      homeUrl: 'https://example.com/',
      articleUrl: 'https://example.com/a-story',
      evilKey: 'https://example.com/evil',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.formValues ?? {})).toEqual(['homeUrl', 'articleUrl']);
  });

  it('accepts www/non-www variants of the same project domain', () => {
    const r = parseCreateProjectBody({
      website_url: 'https://example.com',
      homeUrl: 'https://www.example.com/',
      articleUrl: 'https://example.com/a-story',
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a cross-domain homeUrl', () => {
    const r = parseCreateProjectBody({
      website_url: 'https://example.com',
      homeUrl: 'https://other.com/',
      articleUrl: 'https://example.com/a-story',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('homeUrl must belong to example.com');
  });

  it('rejects a cross-domain articleUrl, including a different subdomain', () => {
    const r = parseCreateProjectBody({
      website_url: 'https://example.com',
      homeUrl: 'https://example.com/',
      articleUrl: 'https://blog.example.com/a-story',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('articleUrl must belong to example.com');
  });

  it('rejects a half-configured project', () => {
    const r = parseCreateProjectBody({
      website_url: 'https://example.com',
      homeUrl: 'https://example.com/',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('articleUrl');
  });

  it('rejects an audit URL with an unsupported protocol', () => {
    const r = parseCreateProjectBody({
      website_url: 'https://example.com',
      homeUrl: 'https://example.com/',
      articleUrl: 'https://example.com/a-story',
      sectionUrl: 'javascript:alert(1)',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('sectionUrl');
  });
});

describe('isAutomationReady', () => {
  it('is true only when both required URLs are present', () => {
    expect(isAutomationReady({ homeUrl: 'https://e.com/', articleUrl: 'https://e.com/a' })).toBe(true);
    expect(isAutomationReady({ homeUrl: 'https://e.com/' })).toBe(false);
    expect(isAutomationReady({ articleUrl: 'https://e.com/a' })).toBe(false);
    expect(isAutomationReady({ homeUrl: 'https://e.com/', articleUrl: '   ' })).toBe(false);
  });

  it('handles the JSON-string form returned by some drivers', () => {
    expect(isAutomationReady('{"homeUrl":"https://e.com/","articleUrl":"https://e.com/a"}')).toBe(true);
    expect(isAutomationReady('{"homeUrl":"https://e.com/"}')).toBe(false);
    expect(isAutomationReady('not json')).toBe(false);
  });

  it('is false for null and non-objects', () => {
    expect(isAutomationReady(null)).toBe(false);
    expect(isAutomationReady(undefined)).toBe(false);
    expect(isAutomationReady(42)).toBe(false);
  });
});
