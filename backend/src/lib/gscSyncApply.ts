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
  compareInventories,
  type CreateOnlyAuditConfig,
  type InventoryComparison,
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
export async function createOnlyProject(
  apiBase: string,
  entry: PlanEntry,
  config?: CreateOnlyAuditConfig | null,
): Promise<WriteResult> {
  const res = await fetch(apiUrl(apiBase, '/api/projects'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(buildCreateOnlyBody(entry, config)),
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
  /** Of `created`, how many were created automation-ready. */
  configured: number;
  updated: number;
  conflicts: number;
  failed: number;
  halted: string | null;
  results: WriteResult[];
}

export interface ApplyOptions {
  createOnly: boolean;
  /**
   * Validated audit configuration per canonical domain. Only entries present
   * here are created configured; every other entry is created identity-only.
   */
  auditConfig?: Record<string, CreateOnlyAuditConfig>;
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
    attempted: 0, created: 0, configured: 0, updated: 0, conflicts: 0, failed: 0,
    halted: null, results: [],
  };

  for (const entry of entries) {
    outcome.attempted++;
    const config = opts.createOnly ? (opts.auditConfig?.[entry.domain] ?? null) : null;
    try {
      const result = opts.createOnly
        ? await createOnlyProject(apiBase, entry, config)
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

      // A freshly created project may only be automation-ready when this run
      // deliberately configured it. Anything else means the route stored audit
      // configuration nobody asked for, and the scheduled runner would pick
      // the row up on its next tick.
      if (result.created && result.automationReady && !config) {
        outcome.halted =
          `${entry.domain} was created automation_ready without --with-audit-config — ` +
          'an identity-only import must never configure audits';
        error(`  UNEXPECTED ${entry.domain} created automation_ready:true — halting`);
        break;
      }
      if (result.created && config && !result.automationReady) {
        outcome.halted =
          `${entry.domain} was created with audit configuration but is not automation_ready — ` +
          'the stored pair is incomplete; refusing to continue';
        error(`  UNEXPECTED ${entry.domain} configured but automation_ready:false — halting`);
        break;
      }
      if (result.created && config) outcome.configured++;

      log(
        `  ${result.created ? 'created' : 'updated'}  ${entry.domain}  HTTP ${result.httpStatus}` +
          (config ? '  [automation-ready]' : ''),
      );
    } catch (err) {
      outcome.failed++;
      outcome.halted = `request failed for ${entry.domain}: ${sanitize(String((err as Error).message))}`;
      error(`  FAILED   ${entry.domain}: ${sanitize(String((err as Error).message))} — halting`);
      break;
    }
  }

  return outcome;
}

// ── verified apply ────────────────────────────────────────────────

export interface VerifiedApplyResult {
  outcome: ApplyOutcome;
  inventoryBefore: ProjectInventoryRecord[];
  inventoryAfter: ProjectInventoryRecord[] | null;
  comparison: InventoryComparison | null;
  /** Set when preservation could not be established, for any reason. */
  verificationError: string | null;
  /** True only when both live reads succeeded and every prior project matched. */
  preservationVerified: boolean;
}

/**
 * Apply, bracketed by two live reads of the target's own project list.
 *
 * Both snapshots come from `GET /api/projects` on the target being written —
 * never from a file. A captured inventory can only describe the moment it was
 * captured, so comparing a write against it would report "unchanged" no matter
 * what the write did; the CLI therefore refuses `--apply --existing-projects`
 * and this function has no parameter that could accept one.
 *
 * A failed post-apply read is itself a failure: preservation is unproven, and
 * unproven is not the same as fine.
 */
export async function applyPlanVerified(
  apiBase: string,
  entries: PlanEntry[],
  opts: ApplyOptions,
): Promise<VerifiedApplyResult> {
  const inventoryBefore = await fetchInventory(apiBase);
  const outcome = await applyPlan(apiBase, entries, opts);

  let inventoryAfter: ProjectInventoryRecord[] | null = null;
  let comparison: InventoryComparison | null = null;
  let verificationError: string | null = null;
  try {
    inventoryAfter = await fetchInventory(apiBase);
    comparison = compareInventories(inventoryBefore, inventoryAfter);
    if (!comparison.preserved) {
      verificationError =
        `${comparison.changed.length} field change(s) and ${comparison.missingIds.length} ` +
        'missing project(s) detected among pre-existing projects';
    }
  } catch (err) {
    verificationError =
      'post-apply GET /api/projects failed, so existing-project preservation could NOT be ' +
      `verified: ${sanitize(String((err as Error).message ?? err))}`;
  }

  return {
    outcome,
    inventoryBefore,
    inventoryAfter,
    comparison,
    verificationError,
    preservationVerified: verificationError === null && comparison !== null && comparison.preserved,
  };
}
