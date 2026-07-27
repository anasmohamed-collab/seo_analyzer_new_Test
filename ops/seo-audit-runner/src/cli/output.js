/**
 * CLI output contract — the versioned envelope and the stdout/stderr split.
 *
 * Two rules define the whole contract, and both are enforced by tests
 * (`test/cliContract.test.js`):
 *
 *  1. **In JSON mode (`--output json`), stdout is exactly one JSON document.**
 *     Nothing else is ever written to stdout — not progress, not warnings,
 *     not usage text, not error messages. Diagnostics go to stderr, which is
 *     where the logger already writes (`src/logger.js` defaults to
 *     process.stderr). That is what makes
 *     `seo-audit-runner doctor --output json > doctor.json` safe.
 *
 *  2. **Every JSON document is the envelope below**, so a consumer can
 *     version-gate on one field instead of sniffing shapes per command.
 *
 * Success:
 *   { schemaVersion: 1, command: "job list", ok: true,
 *     generatedAt: "2026-07-27T…Z", data: … }
 *
 * Failure:
 *   { schemaVersion: 1, command: "job create", ok: false,
 *     generatedAt: "2026-07-27T…Z", error: { code: "CONFLICT", message: "…" } }
 *
 * `ok` is exactly `exitCode === 0`. Commands whose non-zero codes are
 * informational rather than broken — `health`/`doctor` exit 2 when degraded,
 * `run` exits 2 on audit failures — therefore report `ok: false` while still
 * carrying their full result in `data`. Read `data`, not `ok`, for nuance.
 *
 * Bumping `schemaVersion` is the ONLY way to change an existing field's
 * meaning; additive fields do not require a bump.
 */

/** Envelope version. Bump only for a breaking change to existing fields. */
export const CLI_SCHEMA_VERSION = 1;

/**
 * Stable machine-readable error codes. These are part of the CLI contract:
 * a backend may branch on them, so existing codes keep their meaning.
 *
 * The code says WHAT KIND of outcome it was; the EXIT CODE follows the
 * invoking command's own documented table (docs/CLI_CONTRACT.md §3) — the two
 * are related but not a bijection, because `run` reports audit outcomes
 * through exit 2/3 while management commands only ever use 0/1. The one
 * cross-command guarantee is that LOCKED is always exit 4.
 */
export const ERROR_CODES = Object.freeze({
  /** Bad arguments, unknown command, or a missing required flag. Exit 1. */
  USAGE: 'USAGE',
  /** Configuration is invalid or unusable (ConfigError, unwritable state dir). Exit 1. */
  CONFIG: 'CONFIG',
  /** The addressed job or schedule does not exist. Exit 1. */
  NOT_FOUND: 'NOT_FOUND',
  /** Refused on purpose to protect existing work (overlapping job, queued jobs). Exit 1. */
  CONFLICT: 'CONFLICT',
  /** Another runner instance holds the process lock. Always exit 4. */
  LOCKED: 'LOCKED',
  /** The runner-owned SQLite state could not be opened, migrated, or read. Exit 1. */
  STATE: 'STATE',
  /** Outbound call to the application API failed. Exit 1. */
  API: 'API',
  /** health/doctor found warnings but no failure — working, but not clean. Exit 2. */
  DEGRADED: 'DEGRADED',
  /** One or more audits FAILED, TIMED_OUT, or ended with an unknown trigger outcome. Exit 2. */
  AUDIT_FAILURES: 'AUDIT_FAILURES',
  /** Critical (P0) issues found while --fail-on-critical is set. Exit 3. */
  CRITICAL_ISSUES: 'CRITICAL_ISSUES',
  /** Unexpected internal failure, or an aborted run — the catch-all. Exit 1. */
  INTERNAL: 'INTERNAL',
});

const VALID_OUTPUTS = ['text', 'json'];

/**
 * Resolve the output mode from parsed flags.
 * Throws on an unrecognized value rather than silently falling back to text —
 * a typo like `--output jsno` must not quietly produce unparseable stdout.
 */
export function resolveOutputMode(values = {}) {
  const raw = values.output === undefined ? 'text' : String(values.output).toLowerCase();
  if (!VALID_OUTPUTS.includes(raw)) {
    throw new OutputModeError(`--output must be one of ${VALID_OUTPUTS.join(', ')}, got: ${values.output}`);
  }
  return raw;
}

export class OutputModeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OutputModeError';
  }
}

const envelope = (fields) => JSON.stringify({ schemaVersion: CLI_SCHEMA_VERSION, ...fields }, null, 2) + '\n';

/**
 * A command's output writer. Construct one per invocation and route ALL
 * output through it, so the stdout/stderr split cannot drift per command.
 *
 * `stdout`/`stderr` are injectable for tests; they default to the real
 * process streams.
 */
export function createOutput({
  command,
  mode = 'text',
  stdout = process.stdout,
  stderr = process.stderr,
  now = () => new Date().toISOString(),
} = {}) {
  const json = mode === 'json';
  let emitted = false;

  /** Guard: exactly one JSON document per invocation. */
  const claimJsonSlot = () => {
    if (emitted) return false;
    emitted = true;
    return true;
  };

  return {
    command,
    mode,
    get isJson() {
      return json;
    },

    /**
     * Terminal success output.
     * JSON mode: the envelope with `data`. Text mode: `text`, which may be a
     * string or a () => string so callers can skip formatting work in JSON mode.
     */
    ok(data, text) {
      if (json) {
        if (!claimJsonSlot()) return;
        stdout.write(envelope({ command, ok: true, generatedAt: now(), data: data ?? null }));
        return;
      }
      const rendered = typeof text === 'function' ? text() : text;
      if (rendered != null && rendered !== '') {
        stdout.write(rendered.endsWith('\n') ? rendered : `${rendered}\n`);
      }
    },

    /**
     * Terminal failure output. The human message ALWAYS goes to stderr — in
     * both modes — so a failure is visible in a terminal and greppable in a
     * journal even when stdout is redirected to a file.
     */
    fail(code, message, { data = undefined } = {}) {
      stderr.write(`${message}\n`);
      if (!json) return;
      if (!claimJsonSlot()) return;
      stdout.write(
        envelope({
          command,
          ok: false,
          generatedAt: now(),
          ...(data === undefined ? {} : { data }),
          error: { code, message },
        }),
      );
    },

    /**
     * Non-terminal human-facing note (progress, a cancelled-job line, a
     * caveat). Never appears on stdout in JSON mode — put it in `data` if a
     * machine consumer needs it.
     */
    note(text) {
      if (json) {
        stderr.write(`${text}\n`);
        return;
      }
      stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    },
  };
}
