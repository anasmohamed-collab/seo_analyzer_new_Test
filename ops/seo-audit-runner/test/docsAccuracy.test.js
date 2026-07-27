/**
 * Documentation accuracy — the claims that go stale silently.
 *
 * These assertions are deliberately narrow. They do not review prose; they
 * pin the handful of facts that (a) an operator acts on, and (b) drifted
 * before: the unit count, the single scheduling authority, timers shipping
 * disabled, cron/systemd exclusivity, the documented default list bounds, and
 * the boundary statements that keep the runner isolated from the application.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RUNNER_ROOT } from '../tools/shellHarness.js';
import { DEFAULT_LIST_LIMIT } from '../src/cli/manage.js';
import { CLI_SCHEMA_VERSION } from '../src/cli/output.js';

const read = (rel) => fs.readFileSync(path.join(RUNNER_ROOT, rel), 'utf8');

const OPERATOR_DOCS = [
  'README.md',
  'docs/CLI_CONTRACT.md',
  'docs/OPERATIONS_RUNBOOK.md',
  'docs/READINESS_MATRIX.md',
  'docs/DEPLOYMENT_ARCHITECTURE.md',
  'docs/PRODUCTION_GATES.md',
  'deploy/README-deploy.md',
  'deploy/SERVER-HANDOVER.md',
  'deploy/TROUBLESHOOTING.md',
  'deploy/INSTALL-CHECKLIST.md',
];

test('every referenced documentation file exists', () => {
  for (const rel of OPERATOR_DOCS) {
    assert.ok(fs.existsSync(path.join(RUNNER_ROOT, rel)), `missing doc: ${rel}`);
  }
});

test('no doc claims a unit count other than the two tick units', () => {
  // `deploy/systemd/` is the source of truth.
  const units = fs.readdirSync(path.join(RUNNER_ROOT, 'deploy', 'systemd')).sort();
  assert.deepEqual(units, ['seo-runner-tick.service', 'seo-runner-tick.timer']);

  for (const rel of OPERATOR_DOCS) {
    const content = read(rel);
    assert.ok(
      !/\b(three|four|five|six|seven|eight)\s+(systemd\s+)?units?\b/i.test(content),
      `${rel} claims a unit count that no longer matches deploy/systemd/`,
    );
  }
});

test('scheduling docs state one authority, disabled by default, cron-exclusive', () => {
  // The docs an operator reads before enabling automation must carry all
  // three facts — any one of them missing is how a host ends up with a
  // duplicate scheduler.
  for (const rel of [
    'README.md',
    'docs/DEPLOYMENT_ARCHITECTURE.md',
    'docs/OPERATIONS_RUNBOOK.md',
    'deploy/README-deploy.md',
    'deploy/SERVER-HANDOVER.md',
  ]) {
    const content = read(rel);
    assert.match(content, /seo-runner-tick\.timer/, `${rel} must name the tick timer`);
    assert.ok(
      /\bone\b[^.]{0,40}(timer|authority|scheduling)|single scheduling authority|only two|only scheduling authority/i.test(
        content,
      ),
      `${rel} must state that there is exactly one scheduling authority`,
    );
    assert.ok(
      /disabled/i.test(content),
      `${rel} must state that the timer is disabled by default`,
    );
    assert.ok(
      /mutually exclusive|never run alongside|cron and systemd/i.test(content),
      `${rel} must state cron/systemd exclusivity`,
    );
  }
});

test('no doc reintroduces a second timer as if it were current', () => {
  const superseded = /seo-audit-runner\.timer|seo-runner-retry\.timer/;
  for (const rel of OPERATOR_DOCS) {
    const content = read(rel);
    if (!superseded.test(content)) continue;
    // Mentioning them is REQUIRED (they must be removed from old hosts) —
    // but only ever as superseded/misconfigured, never as something to enable.
    assert.ok(
      /superseded|leftover|older install|misconfigur|must not|removed|remove them|duplicat|earlier install|must NOT/i.test(
        content,
      ),
      `${rel} mentions a superseded timer without marking it superseded`,
    );
    assert.ok(
      !/systemctl\s+enable[^\n]*(seo-audit-runner\.timer|seo-runner-retry\.timer)/.test(content),
      `${rel} tells the operator to enable a superseded timer`,
    );
  }
});

test('the runner/application boundary is stated where it matters', () => {
  for (const rel of ['README.md', 'docs/CLI_CONTRACT.md', 'docs/DEPLOYMENT_ARCHITECTURE.md']) {
    const content = read(rel);
    assert.match(content, /SQLite/, `${rel} must say runner state is SQLite`);
    assert.match(content, /PostgreSQL/, `${rel} must name the application's PostgreSQL`);
    assert.ok(
      /never connects|no access to the application|never touches the application|no application database access|never connect/i.test(
        content,
      ),
      `${rel} must state the runner never connects to the application database`,
    );
  }
  const readme = read('README.md');
  assert.ok(
    /no backend module is imported|not import|no file of the main application\s+is imported/i.test(readme),
    'README must state that no backend module is imported',
  );
  assert.ok(
    /does not change crawler|no audit rules|contains no\s+audit rules/i.test(readme),
    'README must state the runner holds no audit/crawler/scoring logic',
  );
});

test('documented default list bounds match the implementation', () => {
  const contract = read('docs/CLI_CONTRACT.md');
  const bound = String(DEFAULT_LIST_LIMIT);
  // The contract table must quote the real default, not a hand-typed one.
  assert.match(
    contract,
    new RegExp(`\\|\\s*\`job list\`\\s*\\|\\s*\\*\\*${bound}\\*\\*`),
    `CLI_CONTRACT job list bound must be ${bound}`,
  );
  assert.match(
    contract,
    new RegExp(`\\|\\s*\`schedule list\`\\s*\\|\\s*\\*\\*${bound}\\*\\*`),
    `CLI_CONTRACT schedule list bound must be ${bound}`,
  );
  assert.match(read('README.md'), new RegExp(`job list\` ${bound}`), 'README must quote the real bound');
});

test('the documented envelope version matches the code', () => {
  const contract = read('docs/CLI_CONTRACT.md');
  assert.match(
    contract,
    new RegExp(`"schemaVersion":\\s*${CLI_SCHEMA_VERSION}`),
    'CLI_CONTRACT must show the current schemaVersion',
  );
  assert.match(read('README.md'), new RegExp(`"schemaVersion":\\s*${CLI_SCHEMA_VERSION}`));
});

test('the readiness matrix keeps Linux and production honestly unverified', () => {
  const matrix = read('docs/READINESS_MATRIX.md');
  for (const status of ['PASS', 'NOT VERIFIED', 'BLOCKED', 'NEEDS LINUX STAGING']) {
    assert.ok(matrix.includes(status), `the matrix must distinguish ${status}`);
  }
  // Local may pass; Linux staging and production may not claim to.
  assert.match(matrix, /Local automation readiness\*{0,2}\s*\|\s*✅?\s*\*{0,2}PASS/);
  assert.match(matrix, /Linux staging readiness\*{0,2}\s*\|[^|\n]*NEEDS LINUX STAGING/);
  assert.match(matrix, /Production readiness\*{0,2}\s*\|[^|\n]*NOT READY/);
  assert.match(matrix, /Timer activation readiness\*{0,2}\s*\|[^|\n]*NOT READY/);
  assert.ok(
    !/production (is )?ready|ready for production/i.test(matrix),
    'the matrix must never claim production readiness',
  );
});

test('docs never instruct enabling a timer without the pre-enable gates', () => {
  for (const rel of OPERATOR_DOCS) {
    const content = read(rel);
    const lines = content.split('\n');
    const enables = lines.filter((l) => /systemctl\s+enable[^\n]*seo-runner-tick\.timer/.test(l));
    if (enables.length === 0) continue;
    assert.ok(
      /pre-enable|PRODUCTION_GATES|Gate 5|§7|gates/i.test(content),
      `${rel} shows 'systemctl enable' without referencing the pre-enable validation/gates`,
    );
  }
});

test('operator docs use `sudo -u seo-runner`, never bare-root runner commands', () => {
  // A bare `sudo seo-audit-runner …` would create root-owned state files.
  for (const rel of ['deploy/SERVER-HANDOVER.md', 'deploy/TROUBLESHOOTING.md', 'deploy/INSTALL-CHECKLIST.md', 'docs/OPERATIONS_RUNBOOK.md']) {
    for (const line of read(rel).split('\n')) {
      assert.ok(
        !/\bsudo\s+seo-audit-runner\b/.test(line),
        `${rel} invokes the runner as root: ${line.trim()}`,
      );
    }
  }
});
