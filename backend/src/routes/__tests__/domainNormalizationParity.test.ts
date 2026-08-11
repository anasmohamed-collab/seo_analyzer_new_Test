/**
 * Regression guard: the manual create path and the implicit audit upsert must
 * derive `sites.domain` from the SAME helper, or one website ends up as two
 * rows depending on how it was registered.
 *
 * The behavioural half asserts the two key derivations agree. The source half
 * pins the audit route to the shared helper, because that route cannot be
 * exercised here without running a real crawl.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeProjectDomain } from '../../lib/normalizeProjectDomain.js';
import { parseCreateProjectBody } from '../../lib/projectInput.js';

const routesDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const auditSource = readFileSync(join(routesDir, 'auditRunsSimple.ts'), 'utf8');
const projectsSource = readFileSync(join(routesDir, 'projects.ts'), 'utf8');

const CASES = [
  'https://example.com',
  'https://www.example.com',
  'http://WWW.Example.COM/news',
  'https://example.com.',
  'https://blog.example.com',
  'https://next.al-madina.com',
  'http://example.com:8080',
  'example.com',
];

describe('shared domain normalization', () => {
  it.each(CASES)(
    'manual creation derives the same sites.domain the audit upsert would use for %s',
    (url) => {
      const viaAudit = normalizeProjectDomain(url);
      const viaCreate = parseCreateProjectBody({ website_url: url });

      expect(viaCreate.ok).toBe(true);
      if (viaCreate.ok) expect(viaCreate.domain).toBe(viaAudit);
    },
  );

  it('collapses www and non-www to one key on both paths', () => {
    const bare = normalizeProjectDomain('https://example.com');
    const www = normalizeProjectDomain('https://www.example.com');
    const created = parseCreateProjectBody({ website_url: 'https://www.example.com' });

    expect(www).toBe(bare);
    expect(created.ok && created.domain).toBe(bare);
  });
});

describe('source wiring', () => {
  it('the audit route imports the shared helper', () => {
    expect(auditSource).toMatch(
      /import \{ normalizeProjectDomain \} from '\.\.\/lib\/normalizeProjectDomain\.js'/,
    );
  });

  it('the audit route upserts sites with the normalized domain', () => {
    expect(auditSource).toMatch(/const siteDomain = normalizeProjectDomain\(body\.homeUrl\)/);

    const upsert = auditSource.slice(auditSource.indexOf('INSERT INTO sites'));
    expect(upsert.slice(0, 400)).toMatch(/\[siteDomain\]/);
  });

  it('the audit route still crawls the un-normalized hostname', () => {
    // runSiteChecks must keep receiving the host the user actually gave us —
    // stripping `www.` here would change audit behaviour.
    expect(auditSource).toMatch(/runSiteChecks\(domain\)/);
    expect(auditSource).toMatch(/const domain = home\.hostname/);
  });

  it('the projects route derives the domain through the shared validator', () => {
    expect(projectsSource).toMatch(/parseCreateProjectBody/);
    expect(projectsSource).not.toMatch(/new URL\(website_url\)\.hostname/);
  });
});
