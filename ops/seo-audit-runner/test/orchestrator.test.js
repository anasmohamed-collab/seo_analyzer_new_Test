import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAudits } from '../src/orchestrator.js';
import { ApiClient, AmbiguousTriggerError } from '../src/apiClient.js';
import { OUTCOME } from '../src/report.js';

const fastConfig = {
  apiBaseUrl: 'http://localhost:3000',
  apiBaseUrlRedacted: 'http://localhost:3000',
  runnerConcurrency: 1,
  pollIntervalMs: 2,
  pollTimeoutMs: 500,
};

const project = (over = {}) => ({
  id: 'p1',
  domain: 'example.com',
  website_url: 'https://example.com',
  project_name: 'Example',
  last_form_values: { homeUrl: 'https://example.com', articleUrl: 'https://example.com/a' },
  completed_count: 1,
  ...over,
});

/** Stub API client with call recording. */
function stubClient(over = {}) {
  const calls = { startAudit: [], getProject: [], getRunResults: [], getLatestAudit: [] };
  const client = {
    calls,
    listProjects: async () => over.projects ?? [project()],
    getProject: async (id) => {
      calls.getProject.push(id);
      return over.getProject ? over.getProject(id) : { id, running_count: 0 };
    },
    getLatestAudit: async (id) => {
      calls.getLatestAudit.push(id);
      return over.getLatestAudit ? over.getLatestAudit(id) : null;
    },
    startAudit: async (body) => {
      calls.startAudit.push(body);
      if (over.startAudit) return over.startAudit(body);
      return { siteId: 's1', auditRunId: 'r1' };
    },
    getRunResults: async (id) => {
      calls.getRunResults.push(id);
      return over.getRunResults(id, calls.getRunResults.length);
    },
  };
  return client;
}

test('completed audit: polls until COMPLETED and extracts P0 issues', async () => {
  const apiClient = stubClient({
    getRunResults: (id, n) =>
      n < 3
        ? { status: 'RUNNING', results: [] }
        : {
            status: 'COMPLETED',
            siteRecommendations: [{ priority: 'P0', area: 'robots', message: 'site issue' }],
            results: [
              {
                url: 'https://example.com',
                data: { pageType: 'home' },
                recommendations: [
                  { priority: 'P0', area: 'meta', message: 'page issue' },
                  { priority: 'P1', area: 'meta', message: 'not critical' },
                ],
              },
            ],
          },
  });

  const report = await runAudits({ config: fastConfig, apiClient, options: {} });
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].outcome, OUTCOME.COMPLETED);
  assert.equal(report.entries[0].auditRunId, 'r1');
  assert.equal(report.entries[0].siteId, 's1');
  assert.equal(report.entries[0].criticalCount, 2);
  assert.equal(report.criticalIssues.length, 2);
  assert.ok(apiClient.calls.getRunResults.length >= 3);
});

test('Beta projects remain included in scheduled audit processing', async () => {
  const projects = [
    project({ is_beta: false }),
    project({
      id: 'p2',
      domain: 'staging.example.com',
      website_url: 'https://staging.example.com',
      project_name: 'Staging',
      is_beta: true,
      last_form_values: {
        homeUrl: 'https://staging.example.com',
        articleUrl: 'https://staging.example.com/a',
      },
    }),
  ];
  const completedProjects = [];
  const apiClient = stubClient({
    projects,
    getRunResults: () => ({ status: 'COMPLETED', results: [] }),
  });

  const report = await runAudits({
    config: fastConfig,
    apiClient,
    options: {
      onProjectCompleted: async ({ project: completedProject }) => {
        completedProjects.push(completedProject);
        return { notificationStatus: completedProject.is_beta ? 'skipped-beta' : 'not-required' };
      },
    },
  });

  assert.equal(apiClient.calls.startAudit.length, 2);
  assert.equal(report.entries.filter((entry) => entry.outcome === OUTCOME.COMPLETED).length, 2);
  assert.deepEqual(completedProjects.map((item) => item.id), ['p1', 'p2']);
  assert.equal(report.entries.find((entry) => entry.projectId === 'p2').notification, 'skipped-beta');
});

test('failed audit: FAILED status is terminal', async () => {
  const apiClient = stubClient({ getRunResults: () => ({ status: 'FAILED' }) });
  const report = await runAudits({ config: fastConfig, apiClient, options: {} });
  assert.equal(report.entries[0].outcome, OUTCOME.FAILED);
  assert.equal(report.criticalIssues.length, 0);
});

test('polling timeout reports TIMED_OUT', async () => {
  const apiClient = stubClient({ getRunResults: () => ({ status: 'RUNNING' }) });
  const config = { ...fastConfig, pollIntervalMs: 2, pollTimeoutMs: 25 };
  const report = await runAudits({ config, apiClient, options: {} });
  assert.equal(report.entries[0].outcome, OUTCOME.TIMED_OUT);
});

test('running_count > 0 skips the audit and never POSTs', async () => {
  const apiClient = stubClient({
    getProject: (id) => ({ id, running_count: 1 }),
    getRunResults: () => ({ status: 'COMPLETED', results: [] }),
  });
  const report = await runAudits({ config: fastConfig, apiClient, options: {} });
  assert.equal(report.entries[0].outcome, OUTCOME.SKIPPED_ALREADY_RUNNING);
  assert.equal(report.entries[0].detail, 'running_count=1');
  assert.equal(apiClient.calls.startAudit.length, 0);
});

test('missing audit config skips with SKIPPED_MISSING_AUDIT_CONFIG', async () => {
  const apiClient = stubClient({
    projects: [project({ last_form_values: null })],
    getRunResults: () => ({ status: 'COMPLETED', results: [] }),
  });
  const report = await runAudits({ config: fastConfig, apiClient, options: {} });
  assert.equal(report.entries[0].outcome, OUTCOME.SKIPPED_MISSING_AUDIT_CONFIG);
  assert.equal(apiClient.calls.startAudit.length, 0);
});

test('duplicates are reported and only the winner is audited', async () => {
  const winner = project({ id: 'a' });
  const loser = project({
    id: 'b',
    domain: 'www.example.com',
    website_url: 'https://www.example.com',
    last_form_values: null,
  });
  const apiClient = stubClient({
    projects: [winner, loser],
    getRunResults: () => ({ status: 'COMPLETED', results: [] }),
  });
  const report = await runAudits({ config: fastConfig, apiClient, options: {} });
  const dedupEntry = report.entries.find((e) => e.outcome === OUTCOME.DEDUPLICATED);
  assert.equal(dedupEntry.projectId, 'b');
  assert.equal(dedupEntry.detail, 'deduplicated: covered by a');
  assert.equal(apiClient.calls.startAudit.length, 1);
});

test('ambiguous trigger: no second POST, outcome TRIGGER_OUTCOME_UNKNOWN', async () => {
  let getProjectCalls = 0;
  const apiClient = stubClient({
    startAudit: () => {
      throw new AmbiguousTriggerError('socket hang up');
    },
    // Pre-flight sees no running audit; the post-ambiguity verification
    // then observes running_count=1 (the POST may have started one).
    getProject: (id) => ({ id, running_count: ++getProjectCalls === 1 ? 0 : 1 }),
    getRunResults: () => ({ status: 'COMPLETED', results: [] }),
  });
  const report = await runAudits({ config: fastConfig, apiClient, options: {} });
  assert.equal(report.entries[0].outcome, OUTCOME.TRIGGER_OUTCOME_UNKNOWN);
  assert.equal(apiClient.calls.startAudit.length, 1, 'trigger POST must not be re-issued');
  assert.match(report.entries[0].detail, /running_count=1/);
});

test('dry run performs zero POST requests (verified through a real ApiClient)', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET' });
    const u = String(url);
    const body = u.endsWith('/api/projects')
      ? { projects: [project()] }
      : u.endsWith('/api/projects/p1')
        ? { project: { id: 'p1', running_count: 0 } }
        : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const apiClient = new ApiClient({ baseUrl: 'http://localhost:3000', fetchImpl, retryBaseDelayMs: 1 });

  const report = await runAudits({ config: fastConfig, apiClient, options: { dryRun: true } });

  assert.equal(report.dryRun, true);
  assert.equal(report.entries[0].outcome, OUTCOME.DRY_RUN_READY);
  assert.deepEqual(report.entries[0].proposedRequest, {
    homeUrl: 'https://example.com',
    articleUrl: 'https://example.com/a',
  });
  assert.ok(requests.length > 0);
  assert.ok(
    requests.every((r) => r.method === 'GET'),
    `expected only GETs, saw: ${JSON.stringify(requests)}`,
  );
});

test('run --project filters to that single project', async () => {
  const apiClient = stubClient({
    projects: [project({ id: 'p1' }), project({ id: 'p2', domain: 'other.com', website_url: 'https://other.com' })],
    getRunResults: () => ({ status: 'COMPLETED', results: [] }),
  });
  const report = await runAudits({ config: fastConfig, apiClient, options: { projectId: 'p2' } });
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].projectId, 'p2');
});

test('unknown --project id throws a runner-level error', async () => {
  const apiClient = stubClient({ getRunResults: () => ({ status: 'COMPLETED', results: [] }) });
  await assert.rejects(
    () => runAudits({ config: fastConfig, apiClient, options: { projectId: 'nope' } }),
    /was not found/,
  );
});

test('abort signal stops polling gracefully', async () => {
  const controller = new AbortController();
  const apiClient = stubClient({
    getRunResults: () => {
      controller.abort();
      return { status: 'RUNNING' };
    },
  });
  const config = { ...fastConfig, pollTimeoutMs: 5000 };
  const report = await runAudits({
    config,
    apiClient,
    options: {},
    signal: controller.signal,
  });
  assert.equal(report.aborted, true);
  assert.equal(report.entries[0].outcome, OUTCOME.ABORTED);
});
