import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config.js';

const FAKE_TOKEN = 'xoxb-000-000-FAKE';
const FAKE_CHANNEL = 'C0123456789';
const FAKE_WEBHOOK = 'https://hooks.slack.com/services/T0/B0/FAKE';

test('bot token + channel ID is selected first, even when a webhook is also set', () => {
  const config = loadConfig({
    SLACK_BOT_TOKEN: FAKE_TOKEN,
    SLACK_CHANNEL_ID: FAKE_CHANNEL,
    SLACK_WEBHOOK_URL: FAKE_WEBHOOK,
  });
  assert.equal(config.slackMethod, 'bot');
});

test('webhook is used as fallback when no bot configuration exists', () => {
  const config = loadConfig({ SLACK_WEBHOOK_URL: FAKE_WEBHOOK });
  assert.equal(config.slackMethod, 'webhook');
});

test('partial bot configuration is rejected', () => {
  assert.throws(() => loadConfig({ SLACK_BOT_TOKEN: FAKE_TOKEN }), ConfigError);
  assert.throws(() => loadConfig({ SLACK_CHANNEL_ID: FAKE_CHANNEL }), ConfigError);
  // …even when a webhook could have been a fallback
  assert.throws(
    () => loadConfig({ SLACK_BOT_TOKEN: FAKE_TOKEN, SLACK_WEBHOOK_URL: FAKE_WEBHOOK }),
    ConfigError,
  );
});

test('notifications enabled without any Slack method is rejected', () => {
  assert.throws(() => loadConfig({ NOTIFICATIONS_ENABLED: 'true' }), ConfigError);
});

test('alert mode disabled requires no Slack credentials', () => {
  const config = loadConfig({
    NOTIFICATIONS_ENABLED: 'true',
    SEO_RUNNER_ALERT_MODE: 'disabled',
  });
  assert.equal(config.alertMode, 'disabled');
  assert.equal(config.slackMethod, null);
});

test('alert mode is validated strictly', () => {
  assert.throws(() => loadConfig({ SEO_RUNNER_ALERT_MODE: 'sometimes' }), ConfigError);
  for (const mode of ['new_or_regressed', 'all_current', 'summary_only', 'disabled']) {
    const env = { SEO_RUNNER_ALERT_MODE: mode };
    if (mode !== 'disabled') env.SLACK_WEBHOOK_URL = FAKE_WEBHOOK;
    assert.equal(loadConfig(env).alertMode, mode);
  }
});

test('SLACK_CRITICAL_MENTION defaults to none when omitted or empty', () => {
  // An existing deployment that never set the variable keeps its current
  // no-mention behavior.
  assert.equal(loadConfig({}).slackCriticalMention, 'none');
  assert.equal(loadConfig({ SLACK_CRITICAL_MENTION: '' }).slackCriticalMention, 'none');
  assert.equal(loadConfig({ SLACK_CRITICAL_MENTION: '   ' }).slackCriticalMention, 'none');
  assert.equal(loadConfig({ SLACK_CRITICAL_MENTION: 'none' }).slackCriticalMention, 'none');
  assert.equal(loadConfig({ SLACK_CRITICAL_MENTION: 'NONE' }).slackCriticalMention, 'none');
  assert.equal(loadConfig({}).slackCriticalMentionNeutralized, false);
  assert.equal(loadConfig({ SLACK_CRITICAL_MENTION: 'none' }).slackCriticalMentionNeutralized, false);
});

test('SLACK_CRITICAL_MENTION=channel is accepted and retained, not neutralized', () => {
  for (const value of ['channel', 'CHANNEL', ' channel ']) {
    const config = loadConfig({ SLACK_CRITICAL_MENTION: value });
    assert.equal(config.slackCriticalMention, 'channel', `${JSON.stringify(value)} must be honored`);
    assert.equal(config.slackCriticalMentionNeutralized, false, 'channel is not a neutralized value');
  }
});

test('here and everyone stay neutralized to none and can never become active', () => {
  for (const mode of ['here', 'everyone']) {
    for (const value of [mode, mode.toUpperCase()]) {
      const config = loadConfig({ SLACK_CRITICAL_MENTION: value });
      assert.equal(config.slackCriticalMention, 'none', `${value} must not be honored`);
      assert.equal(config.slackCriticalMentionNeutralized, true, `${value} must be reported as neutralized`);
    }
  }
});

test('an unrecognized SLACK_CRITICAL_MENTION fails validation instead of falling back', () => {
  for (const value of ['all', '@channel', 'everybody']) {
    assert.throws(
      () => loadConfig({ SLACK_CRITICAL_MENTION: value }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.match(
          err.message,
          /SLACK_CRITICAL_MENTION must be one of channel, here, everyone, none/,
          'the error must name the accepted values',
        );
        return true;
      },
      `value ${JSON.stringify(value)} must be rejected`,
    );
  }
});

test('Phase 3 defaults and state DB path', () => {
  const config = loadConfig({});
  assert.equal(config.alertMode, 'new_or_regressed');
  assert.equal(config.sendRunSummary, true);
  assert.equal(config.slackCriticalMention, 'none');
  assert.equal(config.slackRequestTimeoutMs, 15000);
  assert.equal(config.slackMaxRetries, 4);
  assert.equal(config.slackMaxIssuesPerMessage, 20);
  assert.equal(config.slackMaxMessageCharacters, 30000);
  assert.ok(config.stateDbPath.endsWith('runner-state.sqlite'));

  const custom = loadConfig({ RUNNER_STATE_DB_PATH: '/var/lib/x/runner.sqlite' });
  assert.equal(custom.stateDbPath, '/var/lib/x/runner.sqlite');
});

test('message character limit must stay conservative', () => {
  assert.throws(() => loadConfig({ SLACK_MAX_MESSAGE_CHARACTERS: '50000' }), ConfigError);
});
