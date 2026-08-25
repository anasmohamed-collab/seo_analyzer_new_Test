/**
 * Slack message formatting — compact critical alerts and run summaries.
 *
 * These are pure-function tests: no Slack client is constructed, no fetch
 * implementation is provided, and no network call is possible from here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProjectMessages,
  buildRunSummaryMessage,
  countBroadMentions,
  escapeSlack,
  cleanRecommendation,
  sanitizeSlackMessage,
  stripBroadMentions,
  technicalStatusCategory,
  readTechnicalChecks,
  createTechnicalAggregate,
  addTechnicalResult,
  formatDuration,
  shortId,
  MAX_FIX_CHARACTERS,
  MAX_VISIBLE_CRITICAL_ISSUES,
} from '../src/slackFormat.js';

const mkIssue = (n, over = {}) => ({
  fingerprint: `fp-${n}`,
  area: 'indexability',
  message: `Issue number ${n}`,
  fixHint: `Fix number ${n}`,
  pageUrl: `https://example.com/page-${n}`,
  pageType: 'article',
  source: 'page',
  ...over,
});

const siteChecks = (over = {}) => ({
  robots: { status: 'FOUND' },
  sitemap: { status: 'FOUND' },
  newsSitemap: { status: 'NOT_FOUND' },
  ...over,
});

const baseArgs = (lifecycle, over = {}) => ({
  projectName: 'Example Website',
  domain: 'www.example.com',
  projectId: '7f3a9c21-0000-4000-8000-000000000001',
  auditRunId: '77830569-1111-4000-8000-000000000002',
  auditCompletedAt: '2026-07-13T06:00:00Z',
  lifecycle,
  mode: 'new_or_regressed',
  siteChecks: siteChecks(),
  maxIssuesPerMessage: 20,
  maxMessageCharacters: 30000,
  ...over,
});

const lc = (over = {}) => ({ new: [], reopened: [], unchanged: [], resolved: [], ...over });

const count = (haystack, needle) => haystack.split(needle).length - 1;

// ── Broad mentions: one authorized token, everything else stripped ───

const BROAD = /<!(channel|here|everyone)(\|[^>]*)?>/;

/** Every broad-mention token in a whole message (text + blocks). */
const mentionsIn = (message) => countBroadMentions(message);

test('a Production NEW P0 alert carries exactly one <!channel> when authorized', () => {
  const [message] = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1)] }), { mentionPolicy: 'channel' }),
  );

  assert.equal(mentionsIn(message), 1, 'exactly one token in the entire message');
  assert.equal(message.mentionPolicy, 'channel', 'the message is stamped as authorized');
  assert.match(
    message.blocks[0].text.text,
    /^<!channel> :rotating_light: \*Total Critical Issues: 1\*/,
    'the token opens the visible header',
  );
  assert.ok(!BROAD.test(message.text), 'the top-level fallback keeps no duplicate copy');
  assert.match(message.text, /^:rotating_light: \*Total Critical Issues: 1\*/, 'the fallback starts with the total');
  assert.match(message.text, /:rotating_light: \*Critical SEO Alert\*/, 'the existing alert header remains');
  assert.match(message.text, /\*P0:\* 1 new/);
});

test('a Production REOPENED P0 alert carries exactly one <!channel> when authorized', () => {
  const [message] = buildProjectMessages(
    baseArgs(lc({ reopened: [mkIssue(2)] }), { mentionPolicy: 'channel' }),
  );
  assert.equal(mentionsIn(message), 1);
  assert.match(message.blocks[0].text.text, /^<!channel> /);
  assert.match(message.text, /\*P0:\* 1 reopened/);
});

test('NEW and REOPENED P0 together still produce only one token', () => {
  const [message] = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1)], reopened: [mkIssue(2)], resolved: [mkIssue(3)] }), {
      mentionPolicy: 'channel',
    }),
  );
  assert.equal(mentionsIn(message), 1, 'the NEW/REOPENED P0 authorizes one mention, not one each');
  assert.match(message.text, /\*P0:\* 1 new, 1 reopened \| \*Resolved:\* 1/);
});

test('a multi-block authorized alert still carries exactly one token', () => {
  // Force several section blocks by exceeding the 2900-character chunk size.
  // Titles and fix hints are length-capped, so the bulk comes from the URL.
  const long = (n) => mkIssue(n, { pageUrl: `https://example.com/${'p'.repeat(700)}-${n}` });
  const [message] = buildProjectMessages(
    baseArgs(lc({ new: [long(1), long(2), long(3), long(4), long(5)] }), { mentionPolicy: 'channel' }),
  );
  assert.ok(message.blocks.length > 1, 'this case must actually span multiple blocks');
  assert.equal(mentionsIn(message), 1);
  assert.ok(
    message.blocks.slice(1).every((b) => !BROAD.test(b.text.text)),
    'only the header block carries the token',
  );
  assert.ok(
    message.blocks.every((b) => b.text.text.length <= 3000),
    'the token must not push a block past the Slack section limit',
  );
});

test('an unauthorized policy renders no mention, whatever the lifecycle', () => {
  for (const policy of ['none', '', undefined, 'here', 'everyone', 'CHANNEL', true, '<!channel>']) {
    for (const lifecycle of [
      lc({ new: [mkIssue(1)] }),
      lc({ reopened: [mkIssue(2)] }),
      lc({ unchanged: [mkIssue(3)] }),
      lc({ resolved: [mkIssue(4)] }),
    ]) {
      const [message] = buildProjectMessages(
        baseArgs(lifecycle, { mode: 'all_current', mentionPolicy: policy }),
      );
      assert.equal(mentionsIn(message), 0, `mentionPolicy=${String(policy)} must render no mention`);
      assert.equal(message.mentionPolicy, undefined, 'and stamp no authorization');
      assert.ok(!message.text.includes('@all'), 'never a literal @all');
      assert.ok(!message.text.includes('@channel'), 'never a literal @channel');
    }
  }
});

test('the default (no mentionPolicy argument) stays mention-free', () => {
  for (const lifecycle of [lc({ new: [mkIssue(1)] }), lc({ reopened: [mkIssue(2)] })]) {
    const [message] = buildProjectMessages(baseArgs(lifecycle));
    assert.equal(mentionsIn(message), 0, 'existing callers keep their current behavior');
    assert.equal(message.mentionPolicy, undefined);
  }
});

test('unchanged-only and resolved-only alerts never mention, even when authorized', () => {
  const unchanged = buildProjectMessages(
    baseArgs(lc({ unchanged: [mkIssue(3)] }), { mode: 'all_current', mentionPolicy: 'channel' }),
  )[0];
  assert.equal(mentionsIn(unchanged), 0, 'UNCHANGED-only is not a paging event');
  assert.equal(unchanged.mentionPolicy, undefined);

  const resolved = buildProjectMessages(
    baseArgs(lc({ resolved: [mkIssue(4)] }), { mentionPolicy: 'channel' }),
  )[0];
  assert.equal(mentionsIn(resolved), 0, 'RESOLVED-only is not a paging event');
  assert.match(resolved.text, /\*P0:\* none currently open \| \*Resolved:\* 1/);
});

test('Beta exposure alerts are distinct and never carry a broad mention', () => {
  const exposure = mkIssue(1, {
    priority: 'P0',
    message: 'Beta/Staging seed URL is indexable (no noindex directive detected)',
  });
  // Even with the operator opted in AND a new finding, Beta never pages.
  const [message] = buildProjectMessages(
    baseArgs(lc({ new: [exposure] }), { isBeta: true, mentionPolicy: 'channel' }),
  );

  assert.match(message.text, /^:warning: \*Total Critical Issues: 1\*/);
  assert.match(message.text, /:warning: \*Beta SEO Exposure Alert\*/);
  assert.match(message.text, /\*Exposure findings:\* 1 new/);
  assert.match(message.text, /Beta\/Staging seed URL is indexable/);
  assert.equal(mentionsIn(message), 0);
  assert.equal(message.mentionPolicy, undefined);
  assert.ok(!/\*P0:\*/.test(message.text));
});

test('audit-controlled content cannot inject a broad mention', () => {
  const hostile = (n) =>
    mkIssue(n, {
      message: '<!channel> <!here> <!everyone> <!channel|channel> @channel urgent',
      fixHint: 'Fix by pinging <!channel> and <!everyone>',
      pageUrl: 'https://example.com/<!channel>?x=<!here>',
      pageType: '<!everyone>',
    });

  for (const policy of ['none', 'channel']) {
    const [message] = buildProjectMessages(
      baseArgs(lc({ new: [hostile(1)], resolved: [hostile(2)] }), {
        projectName: '<!channel> Corp',
        domain: 'example.com',
        mentionPolicy: policy,
      }),
    );
    // `channel` authorizes exactly ONE token — the header one this module
    // adds — no matter how many the audit content spells.
    assert.equal(
      mentionsIn(message),
      policy === 'channel' ? 1 : 0,
      `hostile content must not add tokens (policy=${policy})`,
    );
    assert.match(message.text, /&lt;!channel&gt;/, 'audit content stays escaped and visible');
  }
});

test('stripBroadMentions removes every token form and leaves other text alone', () => {
  assert.equal(stripBroadMentions('<!channel> alert'), 'alert');
  assert.equal(stripBroadMentions('<!here|here> alert'), 'alert');
  assert.equal(stripBroadMentions('<!everyone> alert'), 'alert');
  assert.equal(stripBroadMentions('<!CHANNEL> alert'), 'alert');
  assert.equal(stripBroadMentions('<!channel|channel> alert'), 'alert');
  assert.equal(stripBroadMentions('a <!channel> b'), 'a b');
  assert.equal(stripBroadMentions('plain text'), 'plain text');
  assert.equal(stripBroadMentions('<@U123> direct mention'), '<@U123> direct mention');
  assert.equal(stripBroadMentions(''), '');
  assert.equal(stripBroadMentions(null), null);
});

test('sanitizeSlackMessage strips an unauthorized payload without mutating the input', () => {
  const legacy = {
    text: ':rotating_light: <!channel> *Critical SEO Alert*',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: ':rotating_light: <!channel> *Critical SEO Alert*' } },
      { type: 'section', text: { type: 'mrkdwn', text: 'second block <!here>' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'ctx <!everyone>' }] },
    ],
  };
  const before = JSON.parse(JSON.stringify(legacy));

  const clean = sanitizeSlackMessage(legacy);
  assert.equal(countBroadMentions(clean), 0, 'no authorization field means no mention survives');
  assert.match(clean.text, /\*Critical SEO Alert\*/, 'the rest of the message survives');
  assert.deepEqual(legacy, before, 'the stored payload is never mutated');
});

test('sanitizeSlackMessage keeps exactly one token for an authorized payload', () => {
  const authorized = {
    text: ':rotating_light: *Critical SEO Alert*',
    mentionPolicy: 'channel',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '<!channel> :rotating_light: *Critical SEO Alert*' } },
      // Extra tokens beyond the authorized one are still removed.
      { type: 'section', text: { type: 'mrkdwn', text: 'tail <!channel> <!here> <!channel|channel>' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'ctx <!everyone>' }] },
    ],
  };
  const before = JSON.parse(JSON.stringify(authorized));

  const clean = sanitizeSlackMessage(authorized);
  assert.equal(countBroadMentions(clean), 1, 'the authorization buys exactly one token');
  assert.match(clean.blocks[0].text.text, /^<!channel> :rotating_light:/);
  assert.ok(!BROAD.test(clean.blocks[1].text.text), 'surplus tokens are stripped');
  assert.deepEqual(authorized, before, 'the stored payload is never mutated');
});

test('sanitizeSlackMessage always removes the internal authorization field', () => {
  for (const policy of ['channel', 'none', 'here', 'everyone']) {
    const clean = sanitizeSlackMessage({
      text: 'x',
      mentionPolicy: policy,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '<!channel> x' } }],
    });
    assert.ok(!Object.hasOwn(clean, 'mentionPolicy'), `mentionPolicy=${policy} must not survive`);
    assert.deepEqual(Object.keys(clean).sort(), ['blocks', 'text']);
    assert.equal(countBroadMentions(clean), policy === 'channel' ? 1 : 0);
  }
});

test('a labeled or upper-case token is never treated as the authorized one', () => {
  for (const token of ['<!channel|channel>', '<!CHANNEL>', '<!here>', '<!everyone>']) {
    const clean = sanitizeSlackMessage({
      text: '',
      mentionPolicy: 'channel',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${token} header` } }],
    });
    assert.equal(countBroadMentions(clean), 0, `${token} must be stripped`);
    assert.equal(clean.blocks[0].text.text, 'header');
  }
});

test('sanitizeSlackMessage returns the same object when nothing needs stripping', () => {
  const message = { text: 'clean', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'clean' } }] };
  assert.equal(sanitizeSlackMessage(message), message);
});

// ── Compact critical format ─────────────────────────────────────────

test('the critical alert is compact, scannable, and free of ID noise', () => {
  const [message] = buildProjectMessages(
    baseArgs(
      lc({
        new: [
          mkIssue(1, {
            message: 'Missing H1 tag',
            pageType: 'home',
            pageUrl: 'https://www.arabtimesonline.com/',
            fixHint: 'Add exactly one descriptive H1 to the page.',
          }),
        ],
      }),
      { projectName: 'Arab Times', domain: 'arabtimesonline.com' },
    ),
  );
  const text = message.text;
  assert.match(text, /^:rotating_light: \*Total Critical Issues: 1\*/);
  assert.match(text, /:rotating_light: \*Critical SEO Alert\*/);
  assert.match(text, /\*Arab Times\* — `arabtimesonline.com`/);
  assert.match(text, /\*P0:\* 1 new/);
  assert.match(text, /• \*Missing H1 tag\* — Home/);
  assert.match(text, /https:\/\/www\.arabtimesonline\.com\//);
  assert.match(text, /_Fix:_ Add exactly one descriptive H1 to the page\./);
  assert.match(text, /\*Audit:\* `77830569`/);
  assert.ok(!text.includes('Project ID'), 'the project UUID is not shown');
  assert.ok(!text.includes('7f3a9c21-0000-4000-8000-000000000001'), 'no raw project UUID');
  assert.ok(!text.includes('77830569-1111'), 'only the short audit id is visible');
  assert.ok(text.split('\n').length < 15, 'the alert stays short');
});

test('the leading total counts every current P0 lifecycle issue, including issues beyond the visible list', () => {
  const current = Array.from({ length: 7 }, (_, i) => mkIssue(i + 1, { priority: 'P0' }));
  const [message] = buildProjectMessages(
    baseArgs(lc({
      new: current.slice(0, 3),
      reopened: current.slice(3, 5),
      unchanged: current.slice(5),
      resolved: [mkIssue(8, { priority: 'P0' })],
    }), { mode: 'all_current' }),
  );

  assert.match(message.text, /^:rotating_light: \*Total Critical Issues: 7\*/);
  assert.match(message.text, /\*P0:\* 3 new, 2 reopened, 2 unchanged \| \*Resolved:\* 1/);
  assert.equal(
    message.text.split('\n').filter((line) => line.startsWith('• ')).length,
    MAX_VISIBLE_CRITICAL_ISSUES,
    'the total is independent of the five-item presentation cap',
  );
  assert.match(message.text, /\+ 2 more critical issues/);
});

test('a resolved-only alert reports zero currently open Critical Issues', () => {
  const [message] = buildProjectMessages(
    baseArgs(lc({ resolved: [mkIssue(1, { priority: 'P0' })] })),
  );

  assert.match(message.text, /^:rotating_light: \*Total Critical Issues: 0\*/);
  assert.match(message.text, /\*P0:\* none currently open \| \*Resolved:\* 1/);
});

test('project label falls back to the normalized domain, then the project id', () => {
  const byDomain = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1)] }), { projectName: null, domain: 'https://www.example.com/path' }),
  )[0].text;
  assert.match(byDomain, /\*example\.com\*/);
  assert.ok(!/\*example\.com\* — /.test(byDomain), 'the domain is not repeated next to itself');

  const byId = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1)] }), { projectName: null, domain: null, projectId: 'p-1' }),
  )[0].text;
  assert.match(byId, /\*p-1\*/);
});

test('at most five critical issues are shown, with a concise remainder count', () => {
  const many = Array.from({ length: 9 }, (_, i) => mkIssue(i + 1));
  const [message] = buildProjectMessages(baseArgs(lc({ new: many })));
  const bullets = message.text.split('\n').filter((l) => l.startsWith('• '));
  assert.equal(bullets.length, MAX_VISIBLE_CRITICAL_ISSUES);
  assert.match(message.text, /\+ 4 more critical issues/);
  assert.equal(count(message.text, '+ 4 more critical issue'), 1);
});

test('exactly five issues need no remainder line', () => {
  const five = Array.from({ length: 5 }, (_, i) => mkIssue(i + 1));
  const [message] = buildProjectMessages(baseArgs(lc({ new: five })));
  assert.ok(!/more critical issue/.test(message.text));
});

test('a lower SLACK_MAX_ISSUES_PER_MESSAGE still applies below the hard cap', () => {
  const many = Array.from({ length: 9 }, (_, i) => mkIssue(i + 1));
  const [message] = buildProjectMessages(baseArgs(lc({ new: many }), { maxIssuesPerMessage: 2 }));
  assert.equal(message.text.split('\n').filter((l) => l.startsWith('• ')).length, 2);
  assert.match(message.text, /\+ 7 more critical issues/);
});

test('summary_only lists no issues; all_current lists unchanged ones', () => {
  const summaryOnly = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1)], unchanged: [mkIssue(2)] }), { mode: 'summary_only' }),
  )[0].text;
  assert.ok(!summaryOnly.includes('Issue number 1'));
  assert.match(summaryOnly, /\*P0:\* 1 new/);

  const allCurrent = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1)], unchanged: [mkIssue(2)] }), { mode: 'all_current' }),
  )[0].text;
  assert.ok(allCurrent.includes('Issue number 2'));
  assert.match(allCurrent, /\*P0:\* 1 new, 1 unchanged/);
});

test('new_or_regressed hides unchanged issues and their count', () => {
  const text = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1)], unchanged: [mkIssue(2), mkIssue(3)] })),
  )[0].text;
  assert.ok(!text.includes('Issue number 2'));
  assert.ok(!/unchanged/i.test(text));
});

test('resolved issues are listed compactly, without URLs or fix hints', () => {
  const resolved = Array.from({ length: 7 }, (_, i) => mkIssue(i + 1));
  const [message] = buildProjectMessages(baseArgs(lc({ resolved })));
  const text = message.text;
  assert.match(text, /\*Resolved issues\*/);
  assert.match(text, /✓ \*Issue number 1\* — Article/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('✓ ')).length, MAX_VISIBLE_CRITICAL_ISSUES);
  assert.match(text, /\+ 2 more resolved/);
  assert.ok(!text.includes('_Fix:_'), 'a resolved issue needs no fix hint');
  assert.ok(!text.includes('https://example.com/page-1'), 'a resolved issue needs no URL');
  assert.ok(!text.includes('• '), 'resolved issues are not listed as open criticals');
});

test('summary_only never lists resolved issues either', () => {
  const [message] = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1)], resolved: [mkIssue(2)] }), { mode: 'summary_only' }),
  );
  assert.ok(!message.text.includes('Resolved issues'));
  assert.match(message.text, /\*P0:\* 1 new \| \*Resolved:\* 1/);
});

test('site-wide issues render a scope instead of a URL', () => {
  const text = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1, { source: 'site', pageUrl: null })] })),
  )[0].text;
  assert.match(text, /• \*Issue number 1\* — Site-wide/);
});

test('the page type is preserved and readable', () => {
  const text = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1, { pageType: 'video_article' })] })),
  )[0].text;
  assert.match(text, /— Video article/);
});

test('escaping neutralizes Slack control characters', () => {
  assert.equal(escapeSlack('a & <b> c'), 'a &amp; &lt;b&gt; c');
  const text = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1, { message: 'Tag <script> & stuff', pageUrl: 'https://example.com/<x>' })] })),
  )[0].text;
  assert.ok(!text.includes('<script>'));
  assert.ok(text.includes('&lt;script&gt;'));
});

test('blocks stay under the section text limit and always have a text fallback', () => {
  const many = Array.from({ length: 5 }, (_, i) => mkIssue(i + 1, { message: 'y'.repeat(300) }));
  const [message] = buildProjectMessages(baseArgs(lc({ new: many })));
  assert.ok(message.text.length > 0);
  for (const block of message.blocks) assert.ok(block.text.text.length <= 3000);
});

// ── Recommendation cleanup ──────────────────────────────────────────

test('the fix line uses only the canonical recommendation, cleaned', () => {
  const [message] = buildProjectMessages(
    baseArgs(
      lc({
        new: [
          mkIssue(1, {
            message: 'Missing H1 tag',
            // Extra fields that must NEVER be concatenated into the fix text.
            pageTitle: 'Arab Times — Kuwait News',
            evidence: 'Stay updated with the latest news',
            data: { text: 'arabtimeshome Stay updated…' },
            fixHint: 'Each page must have  exactly one &lt;h1&gt; tag.   Each page must have exactly one &lt;h1&gt; tag.',
          }),
        ],
      }),
    ),
  );
  const fixLine = message.text.split('\n').find((l) => l.includes('_Fix:_'));
  assert.equal(fixLine, '  _Fix:_ Each page must have exactly one &lt;h1&gt; tag.');
  assert.ok(!message.text.includes('arabtimeshome'), 'page text never reaches Slack');
  assert.ok(!message.text.includes('Stay updated'), 'evidence text never reaches Slack');
  assert.ok(!message.text.includes('Kuwait News'), 'the page title never reaches Slack');
});

test('fix text is limited to 180 characters and truncated at a word boundary', () => {
  const long = `${'word '.repeat(120)}end`;
  const cleaned = cleanRecommendation(long);
  assert.ok(cleaned.length <= MAX_FIX_CHARACTERS, `got ${cleaned.length}`);
  assert.ok(cleaned.endsWith('…'), 'truncation is marked');
  assert.ok(!cleaned.includes('  '), 'whitespace is collapsed');
  assert.ok(!/\s…$/.test(cleaned), 'truncation happens at a word boundary, without a dangling space');

  const [message] = buildProjectMessages(baseArgs(lc({ new: [mkIssue(1, { fixHint: long })] })));
  const fixLine = message.text.split('\n').find((l) => l.includes('_Fix:_'));
  assert.ok(fixLine.replace('  _Fix:_ ', '').length <= MAX_FIX_CHARACTERS);
});

test('a missing recommendation omits the fix line and is never invented', () => {
  for (const fixHint of [null, undefined, '', '   ']) {
    const [message] = buildProjectMessages(baseArgs(lc({ new: [mkIssue(1, { fixHint })] })));
    assert.ok(!message.text.includes('_Fix:_'), `fixHint=${JSON.stringify(fixHint)} must omit the line`);
  }
  assert.equal(cleanRecommendation(null), null);
});

// ── Technical checks ────────────────────────────────────────────────

test('robots FOUND renders as ✅ Found', () => {
  const [message] = buildProjectMessages(baseArgs(lc({ new: [mkIssue(1)] })));
  assert.match(message.text, /\*Technical:\* Robots ✅ Found \| /);
});

test('sitemap NOT_FOUND renders as ❌ Missing', () => {
  const [message] = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1)] }), { siteChecks: siteChecks({ sitemap: { status: 'NOT_FOUND' } }) }),
  );
  assert.match(message.text, /Sitemap ❌ Missing/);
});

test('the news sitemap is reported separately from the XML sitemap', () => {
  const [message] = buildProjectMessages(
    baseArgs(lc({ new: [mkIssue(1)] }), {
      siteChecks: siteChecks({ sitemap: { status: 'FOUND' }, newsSitemap: { status: 'NOT_FOUND' } }),
    }),
  );
  assert.match(message.text, /Sitemap ✅ Found \| News sitemap ❌ Missing/);
});

test('an absent technical result is Unknown, never Missing', () => {
  for (const value of [null, undefined, {}, { robots: {} }, 'not json']) {
    const [message] = buildProjectMessages(baseArgs(lc({ new: [mkIssue(1)] }), { siteChecks: value }));
    assert.match(
      message.text,
      /\*Technical:\* Robots ❓ Unknown \| Sitemap ❓ Unknown \| News sitemap ❓ Unknown/,
      `siteChecks=${JSON.stringify(value)}`,
    );
  }
});

test('statuses that only prove the check could not complete map to ⚠️ Error', () => {
  for (const status of ['ERROR', 'BLOCKED', 'BOT_PROTECTION', 'SOFT_404', 'INVALID_XML', 'INVALID_FORMAT', 'DISCOVERED']) {
    assert.equal(technicalStatusCategory(status), 'error', status);
  }
  assert.equal(technicalStatusCategory('FOUND'), 'found');
  assert.equal(technicalStatusCategory('NOT_FOUND'), 'missing');
  assert.equal(technicalStatusCategory('SKIPPED'), 'not_checked');
  assert.equal(technicalStatusCategory('SOMETHING_NEW'), 'unknown', 'unsupported data is Unknown');
  assert.equal(technicalStatusCategory(null), 'unknown');
});

test('technical checks are read from the audit result, including a JSON string', () => {
  const asString = JSON.stringify(siteChecks({ robots: { status: 'ERROR' } }));
  assert.deepEqual(readTechnicalChecks(asString), {
    robots: 'error',
    sitemap: 'found',
    newsSitemap: 'missing',
  });
});

// ── Run summary ─────────────────────────────────────────────────────

const summaryTotals = (over = {}) => ({
  discovered: 1, selected: 1, deduplicated: 0, completed: 1, failed: 0, timedOut: 0,
  triggerFailed: 0,
  skippedAlreadyRunning: 0, skippedMissingConfig: 0, triggerOutcomeUnknown: 0,
  projectsWithCritical: 1, currentP0: 1, newIssues: 1, reopenedIssues: 0,
  unchangedIssues: 0, resolvedIssues: 0, notificationFailures: 0,
  ...over,
});

test('the run summary is compact and carries no broad mention', () => {
  const aggregate = createTechnicalAggregate();
  addTechnicalResult(aggregate, siteChecks());
  const { text, blocks } = buildRunSummaryMessage({
    runnerExecutionId: '045fe21a-3333-4000-8000-000000000003',
    startedAt: '2026-07-13T06:00:00Z',
    finishedAt: '2026-07-13T06:02:26Z',
    durationMs: 146_000,
    totals: summaryTotals({ technical: aggregate }),
  });

  assert.match(text, /^:clipboard: \*SEO Audit Summary\*/);
  assert.match(text, /Discovered: 1 \| Eligible: 1 \| Attempted: 1/);
  assert.match(text, /Audited: 1\/1 completed/);
  assert.match(text, /Critical projects: 1 \| Current P0: 1 \| New P0: 1/);
  assert.match(text, /Robots: ✅ 1 \| ❌ 0 \| ⚠️ 0 \| ❓ 0/);
  assert.match(text, /Sitemaps: ✅ 1 \| ❌ 0 \| ⚠️ 0 \| ❓ 0/);
  assert.match(text, /News sitemaps: ✅ 0 \| ❌ 1 \| ⚠️ 0 \| ❓ 0/);
  assert.match(text, /Duration: 2m 26s \| Execution: `045fe21a`/);

  assert.ok(!/<!(channel|here|everyone)>/.test(text), 'summaries never mention the channel');
  assert.ok(!text.includes('@all'));
  assert.ok(!text.includes('Projects discovered'), 'zero-value noise is removed');
  assert.ok(!text.includes('Selected after deduplication'));
  assert.ok(!text.includes('Duplicates skipped'));
  assert.ok(!text.includes('Deferred/Skipped: 0'));
  assert.ok(!text.includes('Failed: 0'));
  assert.ok(!text.includes('Trigger outcome unknown'));
  assert.ok(!text.includes('Failed Slack notifications'));
  assert.ok(!text.includes('2026-07-13T06:00:00Z'), 'ISO timestamps are not shown');
  assert.ok(!text.includes('045fe21a-3333'), 'only the short execution id is shown');
  assert.ok(blocks.length > 0);
  assert.ok(!text.includes('<!channel>'), 'run summaries are informational and must not ping the channel');
});

test('operational counters appear only when non-zero', () => {
  const { text } = buildRunSummaryMessage({
    runnerExecutionId: 'exec-1234-5678',
    durationMs: 20_000,
    totals: summaryTotals({ deduplicated: 2, triggerOutcomeUnknown: 1, notificationFailures: 3 }),
  });
  assert.match(text, /Duplicates skipped: 2/);
  assert.match(text, /Trigger unknown: 1/);
  assert.match(text, /Failed Slack notifications: 3/);
});

test('partial success stays a summary and surfaces only non-zero outcome counts', () => {
  const { text } = buildRunSummaryMessage({
    runnerExecutionId: 'exec-partial',
    durationMs: 90_000,
    totals: summaryTotals({
      discovered: 13,
      eligible: 8,
      attempted: 8,
      completed: 7,
      failed: 1,
      triggerFailed: 1,
      projectsWithCritical: 3,
      currentP0: 4,
      newIssues: 1,
      resolvedIssues: 2,
    }),
  });

  assert.match(text, /^:clipboard: \*SEO Audit Summary\*/);
  assert.match(text, /Audited: 7\/8 completed/);
  assert.match(text, /Critical projects: 3 \| Current P0: 4 \| New P0: 1 \| Resolved P0: 2/);
  assert.match(text, /Failed: 1/);
  assert.ok(!text.includes('SEO Audit Runner Failure'));
  assert.ok(!text.includes('Timed out: 0'));
});

test('an all-trigger failure is an operational alert with reason and affected domains', () => {
  const failedDomains = Array.from({ length: 8 }, (_, index) => `site-${index + 1}.example.com`);
  const { text } = buildRunSummaryMessage({
    runnerExecutionId: 'failure-1234-5678',
    durationMs: 45_000,
    totals: summaryTotals({
      discovered: 13,
      eligible: 8,
      attempted: 8,
      completed: 0,
      failed: 8,
      triggerFailed: 8,
      skipped: 5,
      commonFailureReason: '500: column <created_at> does not exist',
      failedDomains,
      projectsWithCritical: 0,
      currentP0: 0,
      newIssues: 0,
      resolvedIssues: 0,
    }),
  });

  assert.match(text, /^:rotating_light: \*SEO Audit Runner Failure\*/);
  assert.match(text, /8\/8 audit triggers failed\./);
  assert.match(text, /No SEO audits completed\./);
  assert.match(text, /\*Reason:\* 500: column &lt;created_at&gt; does not exist/);
  assert.match(text, /\*Affected:\* `site-1\.example\.com`/);
  assert.match(text, /\+ 3 more/);
  assert.match(text, /Deferred\/Skipped: 5/);
  assert.ok(!/critical/i.test(text));
  assert.ok(!/Audited:/.test(text));
  assert.ok(!/<!(channel|here|everyone)>/.test(text));
});

test('a run with zero completed audits never claims a zero critical state', () => {
  const { text } = buildRunSummaryMessage({
    runnerExecutionId: '1033403c-4444-4000-8000-000000000004',
    durationMs: 20_000,
    totals: summaryTotals({
      discovered: 13, selected: 5, completed: 0, failed: 0, timedOut: 0,
      skippedAlreadyRunning: 2, skippedMissingConfig: 1,
      projectsWithCritical: 0, currentP0: 0, newIssues: 0, resolvedIssues: 0,
      technical: createTechnicalAggregate(),
    }),
  });
  assert.match(text, /No audits completed in this cycle\./);
  assert.match(text, /Discovered: 13 \| Eligible: 5 \| Attempted: 0/);
  assert.match(text, /Deferred\/Skipped: 3/);
  assert.match(text, /Duration: 20s \| Execution: `1033403c`/);
  assert.ok(!/critical/i.test(text), 'no critical-state conclusion without a completed audit');
  assert.ok(!/Robots:/.test(text), 'no technical aggregate without a completed audit');
  assert.ok(!/Audited:/.test(text));
});

test('zero eligible projects says why no audit count exists', () => {
  const { text } = buildRunSummaryMessage({
    runnerExecutionId: 'zero-eligible',
    durationMs: 1000,
    totals: summaryTotals({
      discovered: 5,
      eligible: 0,
      selected: 0,
      completed: 0,
      projectsWithCritical: 0,
      currentP0: 0,
      newIssues: 0,
      resolvedIssues: 0,
    }),
  });
  assert.match(text, /Discovered: 5 \| Eligible: 0 \| Attempted: 0/);
  assert.match(text, /No eligible projects were audited\./);
  assert.ok(!/critical/i.test(text));
});

test('run-summary technical aggregates always total the completed-audit count', () => {
  const aggregate = createTechnicalAggregate();
  const inputs = [
    siteChecks(),                                                    // found / found / missing
    siteChecks({ robots: { status: 'ERROR' } }),                     // error  / found / missing
    siteChecks({ sitemap: { status: 'BLOCKED' } }),                  // found  / error / missing
    null,                                                            // unknown x3
    { robots: { status: 'SKIPPED' } },                               // not_checked → unknown
    { robots: { status: 'FOUND' }, sitemap: { status: 'NOT_FOUND' }, newsSitemap: { status: 'FOUND' } },
  ];
  for (const input of inputs) addTechnicalResult(aggregate, input);

  assert.equal(aggregate.completedAudits, inputs.length);
  for (const key of ['robots', 'sitemap', 'newsSitemap']) {
    const bucket = aggregate[key];
    const total = bucket.found + bucket.missing + bucket.error + bucket.unknown;
    assert.equal(total, aggregate.completedAudits, `${key} buckets must total the completed audits`);
  }
  assert.deepEqual(aggregate.robots, { found: 3, missing: 0, error: 1, unknown: 2 });
  assert.deepEqual(aggregate.sitemap, { found: 2, missing: 1, error: 1, unknown: 2 });
  assert.deepEqual(aggregate.newsSitemap, { found: 1, missing: 3, error: 0, unknown: 2 });

  const { text } = buildRunSummaryMessage({
    runnerExecutionId: 'exec-aggregate',
    durationMs: 1000,
    totals: summaryTotals({ completed: 6, technical: aggregate }),
  });
  assert.match(text, /Robots: ✅ 3 \| ❌ 0 \| ⚠️ 1 \| ❓ 2/);
  assert.ok(!/technical checks cover/.test(text), 'no coverage caveat when the counts match');
});

test('a technical aggregate covering fewer audits than reported says so', () => {
  const aggregate = createTechnicalAggregate();
  addTechnicalResult(aggregate, siteChecks());
  const { text } = buildRunSummaryMessage({
    runnerExecutionId: 'exec-1',
    durationMs: 1000,
    totals: summaryTotals({ completed: 3, technical: aggregate }),
  });
  assert.match(text, /\(technical checks cover 1 of 3 completed audit\(s\)\)/);
});

test('duration and short-id helpers', () => {
  assert.equal(formatDuration(20_000), '20s');
  assert.equal(formatDuration(146_000), '2m 26s');
  assert.equal(formatDuration(3_900_000), '1h 05m');
  assert.equal(formatDuration(undefined), 'unknown');
  assert.equal(shortId('045fe21a-3333-4000'), '045fe21a');
  assert.equal(shortId(null), '-');
});
