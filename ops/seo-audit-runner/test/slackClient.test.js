import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSlackSender,
  SlackPermanentError,
  SlackRetryableError,
  SLACK_POST_MESSAGE_URL,
} from '../src/slackClient.js';
import { createLogger } from '../src/logger.js';
import { buildProjectMessages } from '../src/slackFormat.js';

const FAKE_TOKEN = 'xoxb-000-000-VERYSECRETFAKETOKEN';
const FAKE_WEBHOOK = 'https://hooks.slack.com/services/T0/B0/SECRETWEBHOOKPATH';

/** One P0 issue, shaped exactly as criticalFilter.js produces it. */
const criticalIssue = {
  fingerprint: 'fp-1',
  area: 'content',
  message: 'Missing H1 tag',
  fixHint: 'Add exactly one descriptive H1 to the page.',
  pageUrl: 'https://www.arabtimesonline.com/',
  pageType: 'home',
  source: 'page',
};

const botConfig = (over = {}) => ({
  slackMethod: 'bot',
  slackBotToken: FAKE_TOKEN,
  slackChannelId: 'C0123456789',
  slackRequestTimeoutMs: 5000,
  slackMaxRetries: 2,
  ...over,
});

const webhookConfig = (over = {}) => ({
  slackMethod: 'webhook',
  slackWebhookUrl: FAKE_WEBHOOK,
  slackRequestTimeoutMs: 5000,
  slackMaxRetries: 2,
  ...over,
});

const jsonRes = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fetchQueue(handlers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const h = handlers.shift();
    if (h === undefined) throw new Error('unexpected fetch');
    if (h instanceof Error) throw h;
    if (typeof h === 'function') return h(url, init);
    return h;
  };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};

test('successful bot API delivery posts to chat.postMessage with channel ID', async () => {
  const fetchImpl = fetchQueue([jsonRes({ ok: true })]);
  const sender = createSlackSender({ config: botConfig(), fetchImpl, sleepFn: noSleep });
  const result = await sender.send({ text: 'hello' });
  assert.equal(result.method, 'bot');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, SLACK_POST_MESSAGE_URL);
  const body = JSON.parse(call.init.body);
  assert.equal(body.channel, 'C0123456789');
  assert.equal(body.text, 'hello');
  assert.equal(call.init.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
});

test('successful webhook delivery posts to the webhook URL', async () => {
  const fetchImpl = fetchQueue([new Response('ok', { status: 200 })]);
  const sender = createSlackSender({ config: webhookConfig(), fetchImpl, sleepFn: noSleep });
  const result = await sender.send({ text: 'hello' });
  assert.equal(result.method, 'webhook');
  assert.equal(fetchImpl.calls[0].url, FAKE_WEBHOOK);
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, undefined);
});

test('HTTP 429 honors Retry-After and then succeeds', async () => {
  const delays = [];
  const fetchImpl = fetchQueue([
    jsonRes({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '3' }),
    jsonRes({ ok: true }),
  ]);
  const sender = createSlackSender({
    config: botConfig(),
    fetchImpl,
    sleepFn: async (ms) => { delays.push(ms); },
  });
  await sender.send({ text: 'x' });
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(delays, [3000], 'Retry-After seconds must drive the delay');
});

test('retryable 5xx is retried and can recover', async () => {
  const fetchImpl = fetchQueue([
    new Response('bad gateway', { status: 502 }),
    jsonRes({ ok: true }),
  ]);
  const sender = createSlackSender({ config: botConfig(), fetchImpl, sleepFn: noSleep });
  await sender.send({ text: 'x' });
  assert.equal(fetchImpl.calls.length, 2);
});

test('permanent Slack API error fails immediately without retries', async () => {
  const fetchImpl = fetchQueue([jsonRes({ ok: false, error: 'channel_not_found' })]);
  const sender = createSlackSender({ config: botConfig(), fetchImpl, sleepFn: noSleep });
  await assert.rejects(() => sender.send({ text: 'x' }), SlackPermanentError);
  assert.equal(fetchImpl.calls.length, 1);
});

test('permanent webhook 4xx fails immediately', async () => {
  const fetchImpl = fetchQueue([new Response('invalid_payload', { status: 400 })]);
  const sender = createSlackSender({ config: webhookConfig(), fetchImpl, sleepFn: noSleep });
  await assert.rejects(() => sender.send({ text: 'x' }), SlackPermanentError);
  assert.equal(fetchImpl.calls.length, 1);
});

test('request timeout / network errors are retryable', async () => {
  const timeoutErr = new Error('The operation was aborted due to timeout');
  timeoutErr.name = 'TimeoutError';
  const fetchImpl = fetchQueue([timeoutErr, jsonRes({ ok: true })]);
  const sender = createSlackSender({ config: botConfig(), fetchImpl, sleepFn: noSleep });
  await sender.send({ text: 'x' });
  assert.equal(fetchImpl.calls.length, 2);
});

test('maximum attempts respected, then SlackRetryableError', async () => {
  const fetchImpl = fetchQueue([
    new Response('x', { status: 503 }),
    new Response('x', { status: 503 }),
    new Response('x', { status: 503 }),
  ]);
  const sender = createSlackSender({
    config: botConfig({ slackMaxRetries: 2 }),
    fetchImpl,
    sleepFn: noSleep,
  });
  await assert.rejects(() => sender.send({ text: 'x' }), SlackRetryableError);
  assert.equal(fetchImpl.calls.length, 3, '1 attempt + 2 retries');
});

test('secrets are never present in error messages or logs', async () => {
  const stream = { data: '', write(chunk) { this.data += chunk; } };
  const logger = createLogger({ level: 'debug', stream, secrets: [FAKE_TOKEN, FAKE_WEBHOOK] });

  const fetchImpl = fetchQueue([
    new Response('x', { status: 503 }),
    new Response('x', { status: 503 }),
    new Response('x', { status: 503 }),
  ]);
  const sender = createSlackSender({
    config: webhookConfig({ slackMaxRetries: 2 }),
    fetchImpl,
    logger,
    sleepFn: noSleep,
  });

  let caught;
  try {
    await sender.send({ text: 'x' });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof SlackRetryableError);
  assert.ok(!caught.message.includes('SECRETWEBHOOKPATH'), 'error must not contain the webhook URL');
  assert.ok(!caught.message.includes(FAKE_TOKEN), 'error must not contain the token');
  assert.ok(!stream.data.includes('SECRETWEBHOOKPATH'), 'logs must not contain the webhook URL');
  assert.ok(!stream.data.includes(FAKE_TOKEN), 'logs must not contain the token');
  assert.ok(!stream.data.toLowerCase().includes('authorization'), 'authorization header never logged');
});

test('logger redacts a bot token registered as a secret', () => {
  const stream = { data: '', write(chunk) { this.data += chunk; } };
  const logger = createLogger({ level: 'info', stream, secrets: [FAKE_TOKEN] });
  logger.info(`something mentioning ${FAKE_TOKEN} accidentally`);
  assert.ok(!stream.data.includes(FAKE_TOKEN));
  assert.ok(stream.data.includes('[REDACTED]'));
});

// ── Broad mentions are stripped at the last mile, on both methods ───

test('a bot-token payload leaves the delivered message free of broad mentions', async () => {
  const fetchImpl = fetchQueue([jsonRes({ ok: true })]);
  const sender = createSlackSender({ config: botConfig(), fetchImpl, sleepFn: noSleep });
  const [message] = buildProjectMessages({
    projectName: 'Arab Times',
    domain: 'arabtimesonline.com',
    projectId: 'p1',
    auditRunId: '77830569-aaaa',
    lifecycle: { new: [criticalIssue], reopened: [], unchanged: [], resolved: [] },
    mode: 'new_or_regressed',
    siteChecks: { robots: { status: 'FOUND' }, sitemap: { status: 'FOUND' }, newsSitemap: { status: 'NOT_FOUND' } },
  });

  await sender.send(message);
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.ok(!/<!(channel|here|everyone)>/.test(body.text));
  assert.ok(body.blocks.every((b) => !/<!(channel|here|everyone)>/.test(b.text.text)));
  assert.ok(!body.text.includes('@all'));
  assert.match(body.text, /Critical SEO Alert/, 'the alert itself is intact');
});

test('a legacy stored payload is stripped of its mention before a bot-token retry', async () => {
  const fetchImpl = fetchQueue([jsonRes({ ok: true })]);
  const sender = createSlackSender({ config: botConfig(), fetchImpl, sleepFn: noSleep });
  // Exactly the shape `retry-notifications` replays out of SQLite.
  const legacy = {
    text: ':rotating_light: <!channel> *Critical SEO Alert*\n\n*Arab Times*',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: ':rotating_light: <!channel> *Critical SEO Alert*' } },
      { type: 'section', text: { type: 'mrkdwn', text: 'tail <!here|here>' } },
    ],
  };
  const frozen = JSON.parse(JSON.stringify(legacy));

  await sender.send(legacy);
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.ok(!/<!(channel|here|everyone)/.test(body.text), 'no broad mention leaves the process');
  assert.ok(body.blocks.every((b) => !/<!(channel|here|everyone)/.test(b.text.text)));
  assert.match(body.text, /\*Critical SEO Alert\*/, 'the rest of the legacy body is preserved');
  assert.deepEqual(legacy, frozen, 'the stored notification payload is not mutated');
});

test('a webhook payload gets the same last-mile stripping', async () => {
  const fetchImpl = fetchQueue([new Response('ok', { status: 200 })]);
  const sender = createSlackSender({ config: webhookConfig(), fetchImpl, sleepFn: noSleep });

  await sender.send({
    text: '<!everyone> queued before the change',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '<!everyone> queued before the change' } }],
  });

  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.ok(!/<!(channel|here|everyone)/.test(body.text));
  assert.ok(!/<!(channel|here|everyone)/.test(body.blocks[0].text.text));
  assert.equal(body.text, 'queued before the change');
  assert.ok(!body.text.includes('@all'));
});
