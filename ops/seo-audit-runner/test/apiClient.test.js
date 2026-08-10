import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiClient,
  ApiError,
  NetworkError,
  AmbiguousTriggerError,
  TriggerFailedError,
} from '../src/apiClient.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Sequential fetch mock: each handler serves one call, in order. */
function fetchQueue(handlers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
    const handler = handlers.shift();
    if (handler === undefined) throw new Error(`unexpected fetch call: ${url}`);
    if (handler instanceof Error) throw handler;
    if (typeof handler === 'function') return handler(url, init);
    return handler;
  };
  fn.calls = calls;
  return fn;
}

const client = (fetchImpl, over = {}) =>
  new ApiClient({
    baseUrl: 'http://localhost:3000',
    fetchImpl,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 2,
    requestTimeoutMs: 5000,
    ...over,
  });

test('GET retries on network failure then succeeds', async () => {
  const fetchImpl = fetchQueue([
    new TypeError('fetch failed'),
    json({ projects: [{ id: 'a' }] }),
  ]);
  const projects = await client(fetchImpl).listProjects();
  assert.equal(projects.length, 1);
  assert.equal(fetchImpl.calls.length, 2);
});

test('GET retries on 500 and 429 then succeeds', async () => {
  const fetchImpl = fetchQueue([
    json({ error: 'oops' }, 500),
    json({ error: 'slow down' }, 429),
    json({ projects: [] }),
  ]);
  const projects = await client(fetchImpl).listProjects();
  assert.deepEqual(projects, []);
  assert.equal(fetchImpl.calls.length, 3);
});

test('GET gives up after maxRetries and throws NetworkError', async () => {
  const fetchImpl = fetchQueue([
    new TypeError('down'),
    new TypeError('down'),
    new TypeError('down'),
  ]);
  await assert.rejects(
    () => client(fetchImpl, { maxRetries: 2 }).listProjects(),
    NetworkError,
  );
  assert.equal(fetchImpl.calls.length, 3);
});

test('GET does NOT retry non-transient 4xx', async () => {
  const fetchImpl = fetchQueue([json({ error: 'bad' }, 400)]);
  await assert.rejects(() => client(fetchImpl).listProjects(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 400);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test('getLatestAudit maps 404 to null', async () => {
  const fetchImpl = fetchQueue([json({ error: 'No completed audit' }, 404)]);
  const latest = await client(fetchImpl).getLatestAudit('p1');
  assert.equal(latest, null);
  assert.equal(fetchImpl.calls.length, 1);
});

test('getProject unwraps the project envelope', async () => {
  const fetchImpl = fetchQueue([json({ project: { id: 'p1', running_count: 2 } })]);
  const project = await client(fetchImpl).getProject('p1');
  assert.equal(project.running_count, 2);
  assert.ok(fetchImpl.calls[0].url.endsWith('/api/projects/p1'));
});

test('trigger POST is never retried on network failure (ambiguous)', async () => {
  const fetchImpl = fetchQueue([new TypeError('socket hang up')]);
  await assert.rejects(
    () => client(fetchImpl).startAudit({ homeUrl: 'https://x', articleUrl: 'https://x/a' }),
    AmbiguousTriggerError,
  );
  assert.equal(fetchImpl.calls.length, 1, 'POST must be attempted exactly once');
});

test('trigger POST with HTTP error response is a definitive TriggerFailedError', async () => {
  const fetchImpl = fetchQueue([json({ error: 'homeUrl and articleUrl are required' }, 400)]);
  await assert.rejects(
    () => client(fetchImpl).startAudit({}),
    (err) => {
      assert.ok(err instanceof TriggerFailedError);
      assert.equal(err.status, 400);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test('trigger POST success returns siteId and auditRunId', async () => {
  const fetchImpl = fetchQueue([json({ siteId: 's1', auditRunId: 'r1' })]);
  const result = await client(fetchImpl).startAudit({ homeUrl: 'https://x', articleUrl: 'https://x/a' });
  assert.deepEqual(result, { siteId: 's1', auditRunId: 'r1' });
  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'POST');
  assert.ok(call.url.endsWith('/api/technical-analyzer/run'));
  assert.deepEqual(JSON.parse(call.body), { homeUrl: 'https://x', articleUrl: 'https://x/a' });
});

test('trigger response without auditRunId is ambiguous', async () => {
  const fetchImpl = fetchQueue([json({ something: 'else' })]);
  await assert.rejects(
    () => client(fetchImpl).startAudit({ homeUrl: 'https://x', articleUrl: 'https://x/a' }),
    AmbiguousTriggerError,
  );
});

test('trigger response without siteId is ambiguous', async () => {
  const fetchImpl = fetchQueue([json({ auditRunId: 'r1' })]);
  await assert.rejects(
    () => client(fetchImpl).startAudit({ homeUrl: 'https://x', articleUrl: 'https://x/a' }),
    AmbiguousTriggerError,
  );
});

test('in-memory mode response is a definitive failure with a clear message', async () => {
  const fetchImpl = fetchQueue([json({ mode: 'in-memory', status: 'COMPLETED', results: [] })]);
  await assert.rejects(
    () => client(fetchImpl).startAudit({ homeUrl: 'https://x', articleUrl: 'https://x/a' }),
    (err) => {
      assert.ok(err instanceof TriggerFailedError);
      assert.match(err.message, /in-memory/);
      return true;
    },
  );
});
