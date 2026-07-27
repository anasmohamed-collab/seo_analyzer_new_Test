/**
 * Recurring schedules: storage + timezone-aware occurrence computation.
 *
 * Supported frequencies (contract-aligned; cron expressions are deliberately
 * NOT supported): daily, weekly (day_of_week 0=Sun..6=Sat), monthly
 * (day_of_month 1..31, clamped to the month's last day).
 *
 * Timezone model:
 *  - every schedule stores an IANA timezone (default Africa/Cairo, matching
 *    the production scheduling contract);
 *  - occurrences are computed in local wall-clock time and converted to UTC
 *    using the runtime's zoneinfo (Intl) — no third-party dependency;
 *  - DST: a wall time that does not exist on a transition day resolves to
 *    the instant after the gap; an ambiguous (repeated) wall time resolves
 *    to its first (pre-transition) occurrence;
 *  - missed occurrences (host down): only the MOST RECENT due occurrence is
 *    considered, and only within the catch-up window (default 24h) — at
 *    most one catch-up job, mirroring systemd Persistent=true semantics.
 *
 * Occurrence keys are calendar buckets ('2026-07-21' daily/weekly,
 * '2026-07' monthly). Together with the unique (schedule_id,
 * occurrence_key) jobs index this guarantees one scheduled occurrence
 * creates at most one job, and editing a schedule's time never duplicates
 * a job for an occurrence that already ran.
 */

import { randomUUID } from 'node:crypto';
import { JobStore, JOB_STATUS } from './jobs.js';

export const FREQUENCIES = ['daily', 'weekly', 'monthly'];
export const DEFAULT_TIMEZONE = 'Africa/Cairo';
export const DEFAULT_CATCHUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export class ScheduleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScheduleError';
  }
}

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of `tz` relative to UTC at the given instant. */
function tzOffsetMs(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/** Local calendar parts of an instant in `tz`. */
export function localParts(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const d = new Date(date);
  // Day of week must be derived from the local calendar date, not UTC.
  const utcNoon = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 12);
  return {
    year: Number(parts.year),
    month: Number(parts.month), // 1-based
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    dayOfWeek: new Date(utcNoon).getUTCDay(),
    _instant: d,
  };
}

/**
 * Convert a local wall-clock time in `tz` to a UTC Date.
 * Iterative offset refinement; resolves DST gaps forward and ambiguous
 * times to their first occurrence.
 */
export function wallTimeToUtc(tz, year, month, day, hour, minute) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    guess = wall - tzOffsetMs(tz, new Date(guess));
  }
  return new Date(guess);
}

function daysInMonth(year, month /* 1-based */) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The most recent occurrence of `schedule` at or before `now`.
 * Returns { at: Date, occurrenceKey: string } or null.
 */
export function latestOccurrence(schedule, now = new Date()) {
  const tz = schedule.timezone;
  const { at_hour: hh, at_minute: mm } = schedule;
  const local = localParts(tz, now);

  const daily = (offsetDays) => {
    const base = Date.UTC(local.year, local.month - 1, local.day + offsetDays, 12);
    const d = new Date(base);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      dayOfWeek: d.getUTCDay(),
    };
  };

  const key = (c) =>
    `${c.year}-${String(c.month).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`;

  if (schedule.frequency === 'daily') {
    for (const offset of [0, -1]) {
      const c = daily(offset);
      const at = wallTimeToUtc(tz, c.year, c.month, c.day, hh, mm);
      if (at.getTime() <= now.getTime()) return { at, occurrenceKey: key(c) };
    }
    return null;
  }

  if (schedule.frequency === 'weekly') {
    const targetDow = schedule.day_of_week ?? 0;
    for (let back = 0; back <= 13; back += 1) {
      const c = daily(-back);
      if (c.dayOfWeek !== targetDow) continue;
      const at = wallTimeToUtc(tz, c.year, c.month, c.day, hh, mm);
      if (at.getTime() <= now.getTime()) return { at, occurrenceKey: key(c) };
    }
    return null;
  }

  if (schedule.frequency === 'monthly') {
    const targetDom = schedule.day_of_month ?? 1;
    for (const monthOffset of [0, -1]) {
      let year = local.year;
      let month = local.month + monthOffset;
      if (month < 1) {
        month += 12;
        year -= 1;
      }
      const day = Math.min(targetDom, daysInMonth(year, month));
      const at = wallTimeToUtc(tz, year, month, day, hh, mm);
      if (at.getTime() <= now.getTime()) {
        return { at, occurrenceKey: `${year}-${String(month).padStart(2, '0')}` };
      }
    }
    return null;
  }

  throw new ScheduleError(`unknown frequency: ${schedule.frequency}`);
}

/** The next occurrence strictly after `now` (for status displays). */
export function nextOccurrence(schedule, now = new Date()) {
  const horizonDays = schedule.frequency === 'monthly' ? 62 : 14;
  for (let ahead = 0; ahead <= horizonDays; ahead += 1) {
    const probe = new Date(now.getTime() + ahead * 24 * 60 * 60 * 1000);
    const local = localParts(schedule.timezone, probe);
    const candidates = [];
    if (schedule.frequency === 'daily') {
      candidates.push({ year: local.year, month: local.month, day: local.day });
    } else if (schedule.frequency === 'weekly') {
      if (local.dayOfWeek === (schedule.day_of_week ?? 0)) {
        candidates.push({ year: local.year, month: local.month, day: local.day });
      }
    } else if (schedule.frequency === 'monthly') {
      const day = Math.min(schedule.day_of_month ?? 1, daysInMonth(local.year, local.month));
      if (local.day === day) candidates.push({ year: local.year, month: local.month, day });
    }
    for (const c of candidates) {
      const at = wallTimeToUtc(schedule.timezone, c.year, c.month, c.day, schedule.at_hour, schedule.at_minute);
      if (at.getTime() > now.getTime()) return at;
    }
  }
  return null;
}

// ── Validation ─────────────────────────────────────────────────────

export function validateScheduleInput({
  frequency,
  atHour,
  atMinute,
  dayOfWeek,
  dayOfMonth,
  timezone,
  projectId,
}) {
  const problems = [];
  if (!FREQUENCIES.includes(frequency)) {
    problems.push(`frequency must be one of ${FREQUENCIES.join(', ')} (cron expressions are not supported)`);
  }
  if (!Number.isInteger(atHour) || atHour < 0 || atHour > 23) problems.push('hour must be 0..23');
  if (!Number.isInteger(atMinute) || atMinute < 0 || atMinute > 59) problems.push('minute must be 0..59');
  if (frequency === 'weekly' && (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6)) {
    problems.push('weekly schedules require --day-of-week 0..6 (0=Sunday)');
  }
  if (frequency === 'monthly' && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31)) {
    problems.push('monthly schedules require --day-of-month 1..31');
  }
  if (!isValidTimezone(timezone)) problems.push(`invalid IANA timezone: ${timezone}`);
  if (projectId != null && !/^[A-Za-z0-9._:-]{1,128}$/.test(String(projectId))) {
    problems.push('project id contains unsupported characters');
  }
  if (problems.length > 0) throw new ScheduleError(problems.join('; '));
}

/** Parse "HH:MM" into { atHour, atMinute }. */
export function parseAtTime(raw) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(raw ?? '').trim());
  if (!m) throw new ScheduleError(`--at must be HH:MM (24h), got: ${raw}`);
  return { atHour: Number(m[1]), atMinute: Number(m[2]) };
}

// ── Storage ────────────────────────────────────────────────────────

export class ScheduleStore {
  constructor(db) {
    this.db = db;
  }

  create({ projectId = null, frequency, atHour, atMinute, dayOfWeek = null, dayOfMonth = null, timezone = DEFAULT_TIMEZONE, enabled = false }) {
    validateScheduleInput({ frequency, atHour, atMinute, dayOfWeek, dayOfMonth, timezone, projectId });
    const id = randomUUID();
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO schedules
           (id, project_id, frequency, at_hour, at_minute, day_of_week, day_of_month,
            timezone, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, frequency, atHour, atMinute, dayOfWeek, dayOfMonth, timezone, enabled ? 1 : 0, nowIso, nowIso);
    return this.get(id);
  }

  update(id, changes) {
    const existing = this.get(id);
    if (!existing) throw new ScheduleError(`schedule not found: ${id}`);
    const merged = {
      projectId: changes.projectId !== undefined ? changes.projectId : existing.project_id,
      frequency: changes.frequency ?? existing.frequency,
      atHour: changes.atHour ?? existing.at_hour,
      atMinute: changes.atMinute ?? existing.at_minute,
      dayOfWeek: changes.dayOfWeek !== undefined ? changes.dayOfWeek : existing.day_of_week,
      dayOfMonth: changes.dayOfMonth !== undefined ? changes.dayOfMonth : existing.day_of_month,
      timezone: changes.timezone ?? existing.timezone,
    };
    validateScheduleInput(merged);
    this.db
      .prepare(
        `UPDATE schedules SET
           project_id = ?, frequency = ?, at_hour = ?, at_minute = ?,
           day_of_week = ?, day_of_month = ?, timezone = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.projectId,
        merged.frequency,
        merged.atHour,
        merged.atMinute,
        merged.dayOfWeek,
        merged.dayOfMonth,
        merged.timezone,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  setEnabled(id, enabled) {
    const result = this.db
      .prepare('UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    if (result.changes === 0) throw new ScheduleError(`schedule not found: ${id}`);
    return this.get(id);
  }

  /**
   * Delete a schedule, refusing to strand work it already enqueued.
   *
   * Contract:
   *  - a RUNNING job from this schedule ALWAYS blocks the delete. A job in
   *    flight is a real audit against the live application; it is never
   *    silently deleted and never marked successful. Wait for it, or let
   *    crash recovery resolve it, then delete.
   *  - QUEUED jobs block the delete too, unless `force` is given — with
   *    `force` they are CANCELLED first (an explicit terminal state with a
   *    finished_at, not a silent row removal).
   *  - finished jobs (SUCCEEDED/FAILED/CANCELLED) never block anything. They
   *    keep their `schedule_id` after the delete, so the history of what this
   *    schedule ran stays readable.
   *
   * Returns { cancelledJobIds }.
   */
  delete(id, { force = false, jobStore = new JobStore(this.db) } = {}) {
    if (!this.get(id)) throw new ScheduleError(`schedule not found: ${id}`);

    const active = this.db
      .prepare(
        `SELECT id, status FROM jobs
          WHERE schedule_id = ? AND status IN ('QUEUED', 'RUNNING')
          ORDER BY created_at, rowid`,
      )
      .all(id);
    const running = active.filter((j) => j.status === JOB_STATUS.RUNNING);
    const queued = active.filter((j) => j.status === JOB_STATUS.QUEUED);

    if (running.length > 0) {
      throw new ScheduleError(
        `schedule ${id} still has ${running.length} RUNNING job(s) (${running.map((j) => j.id).join(', ')}) — ` +
          'a running audit is never cancelled or deleted from under itself; ' +
          'wait for it to finish, then delete the schedule',
      );
    }
    if (queued.length > 0 && !force) {
      throw new ScheduleError(
        `schedule ${id} still has ${queued.length} QUEUED job(s) (${queued.map((j) => j.id).join(', ')}) — ` +
          'cancel them first, or re-run with --force to cancel them as part of the delete',
      );
    }

    const cancelledJobIds = [];
    for (const job of queued) {
      jobStore.cancel(job.id);
      cancelledJobIds.push(job.id);
    }
    const result = this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    if (result.changes === 0) throw new ScheduleError(`schedule not found: ${id}`);
    return { cancelledJobIds };
  }

  get(id) {
    return this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) ?? null;
  }

  /**
   * Ordered by (created_at, rowid): when several schedules come due in the
   * same tick, the older one is always considered first, so which occurrence
   * wins a conflict is deterministic rather than insertion-timing luck.
   */
  list({ enabledOnly = false } = {}) {
    return enabledOnly
      ? this.db.prepare('SELECT * FROM schedules WHERE enabled = 1 ORDER BY created_at, rowid').all()
      : this.db.prepare('SELECT * FROM schedules ORDER BY created_at, rowid').all();
  }
}
