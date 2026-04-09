/**
 * classifyPageState.test.ts
 *
 * Unit tests for the classifyPageState function and the PAGE_STATE_MESSAGES map.
 *
 * Scenarios covered:
 *   - Successful crawl (fetchOk) → OK
 *   - HTTP 200 + WAF/CF challenge body → BOT_PROTECTION_CHALLENGE
 *   - HTTP 403 + WAF/CF challenge body → BOT_PROTECTION_CHALLENGE (overrides status)
 *   - Real 401/403 (no challenge) → CRAWLER_BLOCKED (HIGH confidence)
 *   - Fetch success but body decompression failure → PARSE_ERROR
 *   - XML expected but HTML returned (content-type mismatch) → OK (fetch succeeded)
 *   - HTTP 404/410 → NOT_FOUND
 *   - HTTP 5xx → SERVER_ERROR
 *   - Transient timeout/SSL/DNS → FETCH_ERROR (LOW confidence)
 *   - MEDIUM confidence denial → CRAWLER_BLOCKED
 *   - Parser failure does NOT produce CRAWLER_BLOCKED or FETCH_ERROR
 */

import { describe, it, expect } from 'vitest';
import { classifyPageState, PAGE_STATE_MESSAGES } from '../auditRunsSimple.js';
import type { ProfileAttempt } from '../../services/fetch/fetchEngine.js';

// ── Helper: make minimal ProfileAttempt ─────────────────────────

function attempt(
  overrides: Partial<ProfileAttempt> & { failure_kind: ProfileAttempt['failure_kind'] },
): ProfileAttempt {
  return {
    profile:        'chrome-win10',
    attempted_url:  'https://example.com/',
    final_url:      'https://example.com/',
    status:         200,
    ok:             false,
    content_type:   'text/html',
    x_robots_tag:   '',
    redirect_chain: [],
    elapsed_ms:     100,
    html_length:    0,
    cf_challenge:   false,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('classifyPageState — success', () => {
  it('fetchOk=true → OK regardless of other signals', () => {
    expect(classifyPageState(200, true, 'NONE', false, [])).toBe('OK');
  });

  it('fetchOk=true overrides even HIGH confidence (should never happen in practice but is safe)', () => {
    expect(classifyPageState(403, true, 'HIGH', false, [])).toBe('OK');
  });
});

describe('classifyPageState — bot protection challenge', () => {
  it('HTTP 200 + challengeDetected → BOT_PROTECTION_CHALLENGE', () => {
    const profiles = [attempt({ failure_kind: 'waf_challenge', status: 200, cf_challenge: true })];
    expect(classifyPageState(403, false, 'HIGH', true, profiles)).toBe('BOT_PROTECTION_CHALLENGE');
  });

  it('HTTP 403 + challengeDetected → BOT_PROTECTION_CHALLENGE (overrides BLOCKED path)', () => {
    const profiles = [
      attempt({ failure_kind: 'waf_challenge', status: 403, cf_challenge: true }),
      attempt({ profile: 'firefox-linux', failure_kind: 'waf_challenge', status: 403, cf_challenge: true }),
    ];
    expect(classifyPageState(403, false, 'HIGH', true, profiles)).toBe('BOT_PROTECTION_CHALLENGE');
  });

  it('challengeDetected=true has higher priority than NOT_FOUND status', () => {
    // Edge case: should not happen in real use but classifier must be correct.
    const profiles = [attempt({ failure_kind: 'waf_challenge', status: 404, cf_challenge: true })];
    expect(classifyPageState(404, false, 'HIGH', true, profiles)).toBe('BOT_PROTECTION_CHALLENGE');
  });
});

describe('classifyPageState — real blocked (no challenge body)', () => {
  it('HIGH confidence 403 → CRAWLER_BLOCKED', () => {
    const profiles = [
      attempt({ profile: 'chrome-win10',  failure_kind: 'access_denied', status: 403 }),
      attempt({ profile: 'firefox-linux', failure_kind: 'access_denied', status: 403 }),
      attempt({ profile: 'googlebot-2.1', failure_kind: 'access_denied', status: 403 }),
    ];
    expect(classifyPageState(403, false, 'HIGH', false, profiles)).toBe('CRAWLER_BLOCKED');
  });

  it('MEDIUM confidence denial → CRAWLER_BLOCKED', () => {
    const profiles = [
      attempt({ profile: 'chrome-win10',  failure_kind: 'access_denied', status: 403 }),
      attempt({ profile: 'firefox-linux', failure_kind: 'access_denied', status: 403 }),
    ];
    expect(classifyPageState(403, false, 'MEDIUM', false, profiles)).toBe('CRAWLER_BLOCKED');
  });

  it('HIGH confidence 401 → CRAWLER_BLOCKED', () => {
    const profiles = [attempt({ failure_kind: 'access_denied', status: 401 })];
    expect(classifyPageState(401, false, 'HIGH', false, profiles)).toBe('CRAWLER_BLOCKED');
  });
});

describe('classifyPageState — not found / server error', () => {
  it('HTTP 404 → NOT_FOUND', () => {
    const profiles = [attempt({ failure_kind: 'not_found', status: 404 })];
    expect(classifyPageState(404, false, 'HIGH', false, profiles)).toBe('NOT_FOUND');
  });

  it('HTTP 410 → NOT_FOUND', () => {
    const profiles = [attempt({ failure_kind: 'not_found', status: 410 })];
    expect(classifyPageState(410, false, 'HIGH', false, profiles)).toBe('NOT_FOUND');
  });

  it('HTTP 500 → SERVER_ERROR', () => {
    const profiles = [attempt({ failure_kind: 'server_error', status: 500 })];
    expect(classifyPageState(500, false, 'LOW', false, profiles)).toBe('SERVER_ERROR');
  });

  it('HTTP 503 → SERVER_ERROR', () => {
    const profiles = [attempt({ failure_kind: 'server_error', status: 503 })];
    expect(classifyPageState(503, false, 'LOW', false, profiles)).toBe('SERVER_ERROR');
  });
});

describe('classifyPageState — parser failure', () => {
  it('parser_failure → PARSE_ERROR, not FETCH_ERROR', () => {
    const profiles = [attempt({ failure_kind: 'parser_failure', status: 200 })];
    expect(classifyPageState(200, false, 'LOW', false, profiles)).toBe('PARSE_ERROR');
  });

  it('parser_failure → PARSE_ERROR even with LOW confidence', () => {
    // Parser failure gives LOW confidence (not denied/transient), must not become FETCH_ERROR.
    const profiles = [attempt({ failure_kind: 'parser_failure', status: 200 })];
    const result = classifyPageState(0, false, 'LOW', false, profiles);
    expect(result).toBe('PARSE_ERROR');
    expect(result).not.toBe('FETCH_ERROR');
    expect(result).not.toBe('CRAWLER_BLOCKED');
  });

  it('parser_failure → PARSE_ERROR, not CRAWLER_BLOCKED (not a security denial)', () => {
    // A corrupt gzip is not the same as being blocked.
    const profiles = [attempt({ failure_kind: 'parser_failure', status: 200 })];
    expect(classifyPageState(200, false, 'HIGH', false, profiles)).toBe(
      // challenge check runs first, then 404/5xx, then parser failure — HIGH confidence
      // alone does not override PARSE_ERROR since parser failure is checked before blocked.
      'PARSE_ERROR',
    );
  });
});

describe('classifyPageState — transient / fetch error', () => {
  it('timeout (LOW confidence) → FETCH_ERROR', () => {
    const profiles = [attempt({ failure_kind: 'timeout', status: 0 })];
    expect(classifyPageState(0, false, 'LOW', false, profiles)).toBe('FETCH_ERROR');
  });

  it('SSL error (LOW confidence) → FETCH_ERROR', () => {
    const profiles = [attempt({ failure_kind: 'ssl_error', status: 0 })];
    expect(classifyPageState(0, false, 'LOW', false, profiles)).toBe('FETCH_ERROR');
  });

  it('DNS error (LOW confidence) → FETCH_ERROR', () => {
    const profiles = [attempt({ failure_kind: 'dns_error', status: 0 })];
    expect(classifyPageState(0, false, 'LOW', false, profiles)).toBe('FETCH_ERROR');
  });

  it('empty profilesTried → FETCH_ERROR', () => {
    expect(classifyPageState(0, false, 'LOW', false, [])).toBe('FETCH_ERROR');
  });
});

describe('classifyPageState — redirect (fetch succeeded)', () => {
  it('page with redirect chain that ultimately succeeds → OK', () => {
    // fetchOk=true means a profile succeeded regardless of redirect hops.
    expect(classifyPageState(200, true, 'NONE', false, [])).toBe('OK');
  });
});

describe('classifyPageState — content-type mismatch context', () => {
  it('HTTP 200 with HTML body (not XML) when fetch succeeded → OK (checks run on the HTML)', () => {
    // The page returned HTML where XML might be expected (e.g. sitemap URL).
    // The fetch engine still marks this as success; checks run on whatever was returned.
    const profiles = [attempt({ failure_kind: 'success', status: 200, ok: true })];
    expect(classifyPageState(200, true, 'NONE', false, profiles)).toBe('OK');
  });
});

describe('PAGE_STATE_MESSAGES', () => {
  it('has a message for every PageState', () => {
    const states = ['OK', 'BOT_PROTECTION_CHALLENGE', 'CRAWLER_BLOCKED', 'NOT_FOUND', 'SERVER_ERROR', 'PARSE_ERROR', 'FETCH_ERROR'];
    for (const s of states) {
      expect(PAGE_STATE_MESSAGES[s as keyof typeof PAGE_STATE_MESSAGES]).toBeTruthy();
    }
  });

  it('BOT_PROTECTION_CHALLENGE message does not say "could not fetch"', () => {
    expect(PAGE_STATE_MESSAGES.BOT_PROTECTION_CHALLENGE).not.toMatch(/could not be fetched|cannot retrieve/i);
  });

  it('PARSE_ERROR message mentions encoding/decoding', () => {
    expect(PAGE_STATE_MESSAGES.PARSE_ERROR).toMatch(/decode|encod/i);
  });

  it('CRAWLER_BLOCKED message mentions 401 or 403', () => {
    expect(PAGE_STATE_MESSAGES.CRAWLER_BLOCKED).toMatch(/401|403/);
  });
});
