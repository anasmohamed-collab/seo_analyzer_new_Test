import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProjectEligibility } from '../src/eligibility.js';

const config = (over = {}) => ({
  includeProjectIds: new Set(),
  excludeProjectIds: new Set(),
  excludeNonproduction: true,
  requireStoredConfig: true,
  ...over,
});

const project = (over = {}) => ({
  id: 'p1',
  domain: 'example.com',
  website_url: 'https://example.com',
  last_form_values: {
    homeUrl: 'https://www.example.com/',
    articleUrl: 'https://example.com/article',
  },
  ...over,
});

test('stored, same-domain configuration is eligible with www normalization', () => {
  assert.deepEqual(evaluateProjectEligibility(project(), config()), {
    eligible: true,
    reason: 'stored configuration matches project domain',
    source: 'last_form_values',
  });
});

test('missing stored configuration is ineligible by default', () => {
  const decision = evaluateProjectEligibility(project({ last_form_values: null }), config());
  assert.equal(decision.eligible, false);
  assert.match(decision.reason, /stored homeUrl \+ articleUrl/);
});

test('include and exclude lists are enforced and exclusion wins', () => {
  assert.equal(
    evaluateProjectEligibility(project(), config({ includeProjectIds: new Set(['p2']) })).eligible,
    false,
  );
  const both = evaluateProjectEligibility(
    project(),
    config({ includeProjectIds: new Set(['p1']), excludeProjectIds: new Set(['p1']) }),
  );
  assert.equal(both.eligible, false);
  assert.match(both.reason, /explicitly excluded/);
});

test('obvious beta, new and next environment labels are excluded by default', () => {
  for (const label of ['beta', 'new', 'next']) {
    const domain = `${label}.example.com`;
    const decision = evaluateProjectEligibility(
      project({
        domain,
        website_url: `https://${domain}`,
        last_form_values: { homeUrl: `https://${domain}`, articleUrl: `https://${domain}/a` },
      }),
      config(),
    );
    assert.equal(decision.eligible, false, label);
    assert.match(decision.reason, /non-production/);
  }
});

test('an unclassified new.* host is treated as non-production by the runner', () => {
  const decision = evaluateProjectEligibility(
    project({
      domain: 'new.example.com',
      website_url: 'https://new.example.com',
      last_form_values: {
        homeUrl: 'https://new.example.com',
        articleUrl: 'https://new.example.com/a',
      },
    }),
    config(),
  );
  assert.equal(decision.eligible, false);
  assert.match(decision.reason, /non-production/);
});

test('label matching is exact — newtimes.co.rw is a Production site', () => {
  for (const domain of ['newtimes.co.rw', 'newsroom.example.com', 'renew.example.com']) {
    const decision = evaluateProjectEligibility(
      project({
        domain,
        website_url: `https://${domain}`,
        last_form_values: { homeUrl: `https://${domain}`, articleUrl: `https://${domain}/a` },
      }),
      config(),
    );
    assert.equal(decision.eligible, true, `${domain} must stay eligible`);
  }
});

test('new.* with a persisted is_beta=true stays eligible for scheduled monitoring', () => {
  const decision = evaluateProjectEligibility(
    project({
      domain: 'new.example.com',
      website_url: 'https://new.example.com',
      is_beta: true,
      last_form_values: {
        homeUrl: 'https://new.example.com',
        articleUrl: 'https://new.example.com/a',
      },
    }),
    config(),
  );
  assert.equal(decision.eligible, true, 'an explicit Beta classification is authoritative');
  assert.equal(decision.source, 'last_form_values');
});

test('explicit Beta classification remains eligible for auditing despite the domain label', () => {
  const domain = 'staging.example.com';
  const decision = evaluateProjectEligibility(
    project({
      domain,
      website_url: `https://${domain}`,
      is_beta: true,
      last_form_values: { homeUrl: `https://${domain}`, articleUrl: `https://${domain}/a` },
    }),
    config(),
  );

  assert.equal(decision.eligible, true);
  assert.equal(decision.source, 'last_form_values');
});

test('subdomains are preserved when matching project identity', () => {
  const decision = evaluateProjectEligibility(
    project({
      domain: 'news.example.com',
      website_url: 'https://news.example.com',
      last_form_values: {
        homeUrl: 'https://example.com',
        articleUrl: 'https://example.com/a',
      },
    }),
    config(),
  );
  assert.equal(decision.eligible, false);
  assert.match(decision.reason, /does not match/);
});

test('malformed or non-http stored URLs are ineligible', () => {
  for (const homeUrl of ['not a url', 'ftp://example.com/']) {
    const decision = evaluateProjectEligibility(
      project({ last_form_values: { homeUrl, articleUrl: 'https://example.com/a' } }),
      config(),
    );
    assert.equal(decision.eligible, false, homeUrl);
    assert.match(decision.reason, /valid http\(s\)/);
  }
});

test('historical fallback eligibility requires the explicit manual override', () => {
  const missing = project({ last_form_values: null });
  assert.equal(evaluateProjectEligibility(missing, config()).eligible, false);
  const manual = evaluateProjectEligibility(missing, config(), { allowHistoricalFallback: true });
  assert.equal(manual.eligible, true);
  assert.equal(manual.source, 'latest_audit');
});
