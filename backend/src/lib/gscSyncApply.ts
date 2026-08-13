/**
 * The write half of `smacient:gsc-sync`.
 *
 * Separated from the script entry point so the apply loop can be driven
 * end-to-end against the real projects router in tests — the guarantee that
 * matters ("an existing project is never modified") is a property of the
 * client and the route together, not of either alone.
 *
 * Every function here either reads or performs a single guarded POST. Nothing
 * deletes, merges, PATCHes, triggers an audit, or sends a notification.
 */

import {
  buildCreateOnlyBody,
  buildUpsertBody,
  type PlanEntry,
  type ProjectInventoryRecord,
} from './gscSync.js';
import { sanitize } from './gscSyncCli.js';

const USER_AGENT = 'seo-analyzer-smacient-gsc-sync/1.0';

function apiUrl(apiBase: string, path: string): string {
  return `${apiBase.replace(/\/$/, '')}${path}`;
}

// ── reads ─────────────────────────────────────────────────────────

/** The complete project inventory, used as the before/after preservation proof. */
export async function fetchInventory(apiBase: string): Promise<ProjectInventoryRecord[]> {
  const res = await fetch(apiUrl(apiBase, '/api/projects'), {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GET /api/projects returned HTTP ${res.status}`);
  const body = (await res.json()) as { projects?: ProjectInventoryRecord[] };
  if (!Array.isArray(body.projects)) throw new Error('GET /api/projects returned no projects array');
  return body.projects;
}

// ── writes ────────────────────────────────────────────────────────

export interface WriteResult {
  domain: string;
  httpStatus: number;
  created: boolean;
  conflict: boolean;
  automationReady: boolean;
  projectId: string | null;
}

/**
 * One create-only write.
 *
 * The route answers 201 for a row this call inserted and 409 for a domain that
 * already exists — in which case it ran no UPDATE at all. Any other response
 * is unexpected and throws, so the caller halts rather than continuing against
 * a contract it does not recognize.
 */
export async function createOnlyProject(apiBase: string, entry: PlanEntry): Promise<WriteResult> {
  const res = await fetch(apiUrl(apiBase, '/api/projects'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(buildCreateOnlyBody(entry)),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    created?: boolean;
    conflict?: boolean;
    automation_ready?: boolean;
    project?: { id?: string };
    existing_project_id?: string | null;
    error?: string;
  };

  if (res.status === 409) {
    return {
      domain: entry.domain,
      httpStatus: 409,
      created: false,
      conflict: true,
      automationReady: false,
      projectId: body.existing_project_id ?? null,
    };
  }
  if (res.status !== 201 || body.created !== true) {
    throw new Error(
      `POST /api/projects (create_only) for ${entry.domain} returned HTTP ${res.status} ` +
        `with created:${String(body.created)}: ${body.error ?? ''}`,
    );
  }
  return {
    domain: entry.domain,
    httpStatus: res.status,
    created: true,
    conflict: false,
    automationReady: Boolean(body.automation_ready),
    projectId: body.project?.id ?? null,
  };
}

/** One legacy upsert write. Only reachable behind the explicit --allow-updates flag. */
export async function upsertProject(apiBase: string, entry: PlanEntry): Promise<WriteResult> {
  const res = await fetch(apiUrl(apiBase, '/api/projects'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(buildUpsertBody(entry)),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    created?: boolean;
    automation_ready?: boolean;
    project?: { id?: string };
    error?: string;
  };
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`POST /api/projects for ${entry.domain} returned HTTP ${res.status}: ${body.error ?? ''}`);
  }
  return {
    domain: entry.domain,
    httpStatus: res.status,
    created: Boolean(body.created),
    conflict: false,
    automationReady: Boolean(body.automation_ready),
    projectId: body.project?.id ?? null,
  };
}

// ── the apply loop ────────────────────────────────────────────────

export interface ApplyOutcome {
  attempted: number;
  created: number;
  updated: number;
  conflicts: number;
  failed: number;
  halted: string | null;
  results: WriteResult[];
}

export interface ApplyOptions {
  createOnly: boolean;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

/**
 * Write the planned entries, halting on the first conflict or unexpected
 * response.
 *
 * In create-only mode the entry list must already be `plan.create` alone;
 * buildCreateOnlyBody re-checks every entry and throws on anything else, so a
 * proposed update cannot reach the network even if a caller passes one in.
 */
export async function applyPlan(
  apiBase: string,
  entries: PlanEntry[],
  opts: ApplyOptions,
): Promise<ApplyOutcome> {
  const log = opts.log ?? (() => undefined);
  const error = opts.error ?? (() => undefined);
  const outcome: ApplyOutcome = {
    attempted: 0, created: 0, updated: 0, conflicts: 0, failed: 0, halted: null, results: [],
  };

  for (const entry of entries) {
    outcome.attempted++;
    try {
      const result = opts.createOnly
        ? await createOnlyProject(apiBase, entry)
        : await upsertProject(apiBase, entry);
      outcome.results.push(result);

      if (result.conflict) {
        // The project appeared between planning and this write. The route left
        // it untouched, and so do we — the plan is stale, so stop here.
        outcome.conflicts++;
        outcome.halted =
          `conflict on ${entry.domain}: HTTP 409, the project already exists and was left untouched`;
        error(`  CONFLICT ${entry.domain}  HTTP 409 — existing project untouched, halting`);
        break;
      }

      // Legacy upsert only: a planned create answering created:false means the
      // row already existed and has just been updated by this very call.
      if (!opts.createOnly && entry.action === 'create' && !result.created) {
        outcome.conflicts++;
        outcome.halted =
          `conflict on ${entry.domain}: expected HTTP 201 with created:true, ` +
          `got HTTP ${result.httpStatus} with created:false`;
        error(`  CONFLICT ${entry.domain}  HTTP ${result.httpStatus} created:false — halting`);
        break;
      }

      if (result.created) outcome.created++;
      else outcome.updated++;

      if (result.created && result.automationReady) {
        // A freshly created project carrying audit configuration would be
        // picked up by the scheduled runner. That must never happen here.
        outcome.halted =
          `${entry.domain} was created automation_ready — a create-only import must never configure audits`;
        error(`  UNEXPECTED ${entry.domain} created automation_ready:true — halting`);
        break;
      }

      log(`  ${result.created ? 'created' : 'updated'}  ${entry.domain}  HTTP ${result.httpStatus}`);
    } catch (err) {
      outcome.failed++;
      outcome.halted = `request failed for ${entry.domain}: ${sanitize(String((err as Error).message))}`;
      error(`  FAILED   ${entry.domain}: ${sanitize(String((err as Error).message))} — halting`);
      break;
    }
  }

  return outcome;
}
