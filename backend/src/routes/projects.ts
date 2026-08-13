/**
 * Project management & audit history API
 *
 * Mounts under /api in server/index.js.
 * All endpoints require a configured DATABASE_URL — returns 501 otherwise.
 * The audit engine (auditRunsSimple.ts) is never imported or modified here.
 *
 * Endpoints:
 *   GET    /api/projects                          — list all projects
 *   POST   /api/projects                          — create (201) / update existing (200)
 *                                                   with create_only:true → create (201) / conflict (409)
 *   GET    /api/projects/:id                      — single project + stats
 *   PATCH  /api/projects/:id                      — update name and/or environment
 *   DELETE /api/projects/:id                      — delete project (cascades)
 *   GET    /api/projects/:id/audits               — paginated audit history
 *   GET    /api/projects/:id/audits/latest        — latest completed audit
 *   GET    /api/audits/compare?a=<id>&b=<id>      — diff two audit runs
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../lib/db.js';
import { compareAudits, AuditSnapshot, AuditPage } from '../lib/compareAudits.js';
import {
  parseCreateProjectBody,
  parseProjectFormValues,
  isAutomationReady,
} from '../lib/projectInput.js';
import { staleAuditTimeoutMinutes } from '../lib/staleAuditRuns.js';

export const projectsRouter = Router();

// ── Guard helper ─────────────────────────────────────────────────

function requireDb(res: Response): ReturnType<typeof getDb> | null {
  const db = getDb();
  if (!db) {
    res.status(501).json({
      error: 'Database required for project management. Set DATABASE_URL and run migrations.',
    });
    return null;
  }
  return db;
}

function withAutomationReady<T extends { last_form_values?: unknown }>(project: T) {
  return { ...project, automation_ready: isAutomationReady(project.last_form_values) };
}

// ── GET /api/projects ─────────────────────────────────────────────

projectsRouter.get('/projects', async (_req: Request, res: Response) => {
  const db = requireDb(res);
  if (!db) return;

  try {
    const { rows } = await db.query(`
      SELECT
        s.id,
        s.domain,
        s.project_name,
        s.website_url,
        s.is_beta,
        s.created_at,
        s.last_audit_at,
        s.last_form_values,
        COUNT(ar.id)::int                                             AS audit_count,
        COUNT(ar.id) FILTER (WHERE ar.status = 'COMPLETED')::int     AS completed_count
      FROM sites s
      LEFT JOIN audit_runs ar ON ar.site_id = s.id
      GROUP BY s.id
      ORDER BY GREATEST(
                 COALESCE(s.last_audit_at, s.created_at::timestamptz),
                 s.created_at::timestamptz
               ) DESC,
               s.created_at DESC
    `);
    res.json({ projects: rows.map(withAutomationReady) });
  } catch (err) {
    console.error('GET /api/projects error:', err);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// ── POST /api/projects ────────────────────────────────────────────

projectsRouter.post('/projects', async (req: Request, res: Response) => {
  const db = requireDb(res);
  if (!db) return;

  const parsed = parseCreateProjectBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const { domain, websiteUrl, projectName, isBeta, formValues, createOnly, withAuditConfig } = parsed;

  // ── create-only contract ────────────────────────────────────────
  //
  // A single atomic statement: either this request inserts the row or the row
  // already existed and nothing happens. There is deliberately no SELECT-then-
  // INSERT here — a check-then-write would leave a window in which a concurrent
  // creation turns this call into an update of somebody else's project. There
  // is equally no create-then-PATCH: the audit configuration, when explicitly
  // requested, is part of the same INSERT, so a project can never exist in a
  // half-configured state and a conflict can never lead to a follow-up write.
  //
  // ON CONFLICT (domain) DO NOTHING means an existing project is not touched at
  // all: no UPDATE runs, so project_name, website_url, is_beta,
  // last_form_values, created_at and updated_at all keep their stored values.
  //
  // Without with_audit_config the last_form_values parameter is NULL, so a
  // created row starts NULL and is never automation-ready.
  if (createOnly) {
    const configuredValues = withAuditConfig && formValues ? JSON.stringify(formValues) : null;
    try {
      const inserted = await db.query<Record<string, unknown>>(
        `INSERT INTO sites (domain, project_name, website_url, is_beta, last_form_values, updated_at)
         VALUES ($1, $2, $3, COALESCE($4::boolean, FALSE), $5::jsonb, NOW())
         ON CONFLICT (domain) DO NOTHING
         RETURNING *`,
        [domain, projectName, websiteUrl, isBeta, configuredValues],
      );

      if (!inserted.rows.length) {
        // Read-only lookup so the caller can identify the blocking row. This
        // runs after the insert attempt, writes nothing, and is deliberately
        // NOT followed by a PATCH — a conflict ends the request.
        const existing = await db.query<{ id: string; domain: string }>(
          'SELECT id, domain FROM sites WHERE domain = $1',
          [domain],
        );
        res.status(409).json({
          error: `A project already exists for ${domain}`,
          created: false,
          conflict: true,
          domain,
          existing_project_id: existing.rows[0]?.id ?? null,
        });
        return;
      }

      const project = inserted.rows[0];
      res.status(201).json({
        project: withAutomationReady(project),
        created: true,
        conflict: false,
        automation_ready: isAutomationReady(project.last_form_values),
      });
    } catch (err) {
      console.error('POST /api/projects (create_only) error:', err);
      res.status(500).json({ error: 'Failed to create project' });
    }
    return;
  }

  try {
    // `xmax = 0` is true only for a freshly inserted row, so a single
    // upsert still tells us whether it created or updated the project.
    // last_form_values is only overwritten when this request carried a
    // complete, valid audit configuration — never erased by a request
    // that omitted it.
    const { rows } = await db.query<Record<string, unknown> & { created: boolean }>(
      `INSERT INTO sites (domain, project_name, website_url, last_form_values, is_beta, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, COALESCE($5::boolean, FALSE), NOW())
       ON CONFLICT (domain) DO UPDATE
         SET project_name     = EXCLUDED.project_name,
             website_url      = EXCLUDED.website_url,
             last_form_values = COALESCE(EXCLUDED.last_form_values, sites.last_form_values),
             is_beta          = CASE
                                  WHEN $5::boolean IS NULL THEN sites.is_beta
                                  ELSE EXCLUDED.is_beta
                                END,
             updated_at       = NOW()
       RETURNING *, (xmax = 0) AS created`,
      [domain, projectName, websiteUrl, formValues ? JSON.stringify(formValues) : null, isBeta],
    );

    const { created, ...project } = rows[0];
    res.status(created ? 201 : 200).json({
      project: withAutomationReady(project),
      created,
      automation_ready: isAutomationReady(project.last_form_values),
    });
  } catch (err) {
    console.error('POST /api/projects error:', err);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// ── GET /api/projects/:id ─────────────────────────────────────────

projectsRouter.get('/projects/:id', async (req: Request, res: Response) => {
  const db = requireDb(res);
  if (!db) return;

  try {
    // `running_count` counts only NON-STALE running audits. The runner uses it
    // as a pre-flight check and skips the project entirely when it is > 0, so a
    // crashed row left RUNNING forever would block that project permanently —
    // POST-side recovery alone could never be reached. This read stays strictly
    // read-only: nothing is recovered here. Excluding stale rows only lets the
    // runner proceed to POST, where the authoritative transactional recovery
    // happens under the existing locks. `stale_running_count` is exposed for
    // observability.
    const staleTimeoutMinutes = staleAuditTimeoutMinutes();
    const { rows } = await db.query(
      `SELECT
         s.*,
         COUNT(ar.id)::int                                           AS audit_count,
         COUNT(ar.id) FILTER (WHERE ar.status = 'COMPLETED')::int   AS completed_count,
         COUNT(ar.id) FILTER (
           WHERE ar.status = 'RUNNING'
             AND ar.started_at >= NOW() - make_interval(mins => $2::int)
         )::int                                                      AS running_count,
         COUNT(ar.id) FILTER (
           WHERE ar.status = 'RUNNING'
             AND ar.started_at < NOW() - make_interval(mins => $2::int)
         )::int                                                      AS stale_running_count
       FROM sites s
       LEFT JOIN audit_runs ar ON ar.site_id = s.id
       WHERE s.id = $1
       GROUP BY s.id`,
      [req.params.id, staleTimeoutMinutes],
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ project: withAutomationReady(rows[0]) });
  } catch (err) {
    console.error('GET /api/projects/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

// ── PATCH /api/projects/:id ───────────────────────────────────────

projectsRouter.patch('/projects/:id', async (req: Request, res: Response) => {
  const db = requireDb(res);
  if (!db) return;

  const body = req.body ?? {};
  const projectName = body.project_name;
  const rawIsBeta = body.is_beta ?? body.isBeta;
  const hasProjectName = projectName !== undefined;
  const hasIsBeta = rawIsBeta !== undefined;

  if (!hasProjectName && !hasIsBeta) {
    res.status(400).json({ error: 'project_name or is_beta is required' });
    return;
  }
  if (hasProjectName && (typeof projectName !== 'string' || !projectName.trim())) {
    res.status(400).json({ error: 'project_name must be a non-empty string' });
    return;
  }
  if (hasIsBeta && typeof rawIsBeta !== 'boolean') {
    res.status(400).json({ error: 'is_beta must be a boolean' });
    return;
  }

  try {
    const { rows } = await db.query(
      `UPDATE sites
       SET project_name = COALESCE($1, project_name),
           is_beta = COALESCE($2::boolean, is_beta),
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [hasProjectName ? projectName.trim() : null, hasIsBeta ? rawIsBeta : null, req.params.id],
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ project: rows[0] });
  } catch (err) {
    console.error('PATCH /api/projects/:id error:', err);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

// ── DELETE /api/projects/:id ──────────────────────────────────────

projectsRouter.delete('/projects/:id', async (req: Request, res: Response) => {
  const db = requireDb(res);
  if (!db) return;

  try {
    // FK cascade handles audit_runs → audit_results deletion
    const { rows } = await db.query(
      `DELETE FROM sites WHERE id = $1 RETURNING *`,
      [req.params.id],
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ deleted: rows[0] });
  } catch (err) {
    console.error('DELETE /api/projects/:id error:', err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// ── GET /api/projects/:id/audits ──────────────────────────────────

projectsRouter.get('/projects/:id/audits', async (req: Request, res: Response) => {
  const db = requireDb(res);
  if (!db) return;

  const page  = Math.max(1, parseInt(String(req.query.page  ?? '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));
  const offset = (page - 1) * limit;

  try {
    // Verify project exists
    const siteCheck = await db.query('SELECT id FROM sites WHERE id = $1', [req.params.id]);
    if (!siteCheck.rows.length) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Aggregated audit list — single query, no N+1
    const { rows } = await db.query(
      `SELECT
         ar.id,
         ar.site_id                                                        AS project_id,
         ar.status,
         ar.started_at                                                     AS audit_date,
         ar.finished_at,
         EXTRACT(EPOCH FROM (ar.finished_at - ar.started_at))::int * 1000 AS duration_ms,
         COUNT(res.id)::int                                                AS total_pages,
         COUNT(res.id) FILTER (WHERE res.status = 'PASS')::int            AS passed,
         COUNT(res.id) FILTER (WHERE res.status = 'WARN')::int            AS warnings,
         COUNT(res.id) FILTER (WHERE res.status = 'FAIL')::int            AS failed,
         COALESCE(
           (SELECT SUM(p0.cnt) FROM (
             SELECT COUNT(*) AS cnt
             FROM audit_results res2
             CROSS JOIN LATERAL jsonb_array_elements(COALESCE(res2.recommendations, '[]'::jsonb)) AS rec
             WHERE res2.audit_run_id = ar.id
               AND rec->>'priority' = 'P0'
           ) p0), 0
         )::int                                                            AS critical,
         ROUND(
           AVG((res.data -> 'layeredScore' -> 'overall')::numeric), 1
         )                                                                 AS score
       FROM audit_runs ar
       LEFT JOIN audit_results res ON res.audit_run_id = ar.id
       WHERE ar.site_id = $1
       GROUP BY ar.id
       ORDER BY ar.started_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset],
    );

    // Total count for pagination
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM audit_runs WHERE site_id = $1`,
      [req.params.id],
    );
    const total = countRes.rows[0].total;

    res.json({
      audits: rows.map(r => ({
        audit_id:    r.id,
        project_id:  r.project_id,
        audit_date:  r.audit_date,
        status:      r.status,
        duration_ms: r.duration_ms,
        results: {
          score:    r.score != null ? parseFloat(r.score) : null,
          passed:   r.passed,
          warnings: r.warnings,
          failed:   r.failed,
          critical: r.critical,
        },
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('GET /api/projects/:id/audits error:', err);
    res.status(500).json({ error: 'Failed to fetch audit history' });
  }
});

// ── GET /api/projects/:id/audits/latest ───────────────────────────

projectsRouter.get('/projects/:id/audits/latest', async (req: Request, res: Response) => {
  const db = requireDb(res);
  if (!db) return;

  try {
    // Find latest COMPLETED run for this project
    const runRes = await db.query(
      `SELECT * FROM audit_runs
       WHERE site_id = $1 AND status = 'COMPLETED'
       ORDER BY started_at DESC
       LIMIT 1`,
      [req.params.id],
    );

    if (!runRes.rows.length) {
      res.status(404).json({ error: 'No completed audit found for this project' });
      return;
    }
    const run = runRes.rows[0];

    // Fetch all result rows for that run
    const resultsRes = await db.query(
      `SELECT url, status, data, recommendations
       FROM audit_results
       WHERE audit_run_id = $1
       ORDER BY created_at`,
      [run.id],
    );
    const resultRows = resultsRes.rows;

    // Compute aggregates
    let passed = 0, warnings = 0, failed = 0, critical = 0;
    let scoreSum = 0, scoreCount = 0;
    const allIssues: unknown[] = [];

    const page_breakdown = resultRows.map(r => {
      if (r.status === 'PASS')      passed++;
      else if (r.status === 'WARN') warnings++;
      else if (r.status === 'FAIL') failed++;

      const recs: Array<{ priority: string; area: string; message: string }> =
        Array.isArray(r.recommendations) ? r.recommendations : [];

      const p0 = recs.filter(rec => rec.priority === 'P0');
      critical += p0.length;

      const rawScore = r.data?.layeredScore?.overall;
      if (rawScore != null) {
        scoreSum += Number(rawScore);
        scoreCount++;
      }

      // Collect P0 + P1 for top-level issues list
      const topRecs = recs.filter(rec => rec.priority === 'P0' || rec.priority === 'P1');
      allIssues.push(...topRecs);

      return {
        url:             r.url,
        page_type:       r.data?.pageType ?? null,
        status:          r.status,
        score:           rawScore != null ? Math.round(Number(rawScore) * 10) / 10 : null,
        recommendations: recs,
      };
    });

    const score = scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 10) / 10 : null;

    res.json({
      audit_id:    run.id,
      project_id:  run.site_id,
      audit_date:  run.started_at,
      finished_at: run.finished_at,
      site_checks: run.site_checks,
      results: {
        score,
        passed,
        warnings,
        failed,
        critical,
        issues:         allIssues,
        page_breakdown,
      },
    });
  } catch (err) {
    console.error('GET /api/projects/:id/audits/latest error:', err);
    res.status(500).json({ error: 'Failed to fetch latest audit' });
  }
});

// ── PATCH /api/projects/:id/form-values ──────────────────────────
// Saves the last-used form inputs for a project so the UI can
// pre-fill the analyzer form when the project is re-selected.
// Called by the frontend after an audit run is started (DB mode).
// Never touches audit_runs or audit_results — pure metadata update.

projectsRouter.patch('/projects/:id/form-values', async (req: Request, res: Response) => {
  const db = requireDb(res);
  if (!db) return;

  try {
    const existing = await db.query<{ id: string; domain: string }>(
      'SELECT id, domain FROM sites WHERE id = $1',
      [req.params.id],
    );
    if (!existing.rows.length) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const parsed = parseProjectFormValues(req.body, existing.rows[0].domain, {
      requireConfiguration: true,
    });
    if (!parsed.ok || parsed.formValues === null) {
      res.status(400).json({ error: parsed.ok ? 'homeUrl and articleUrl are required' : parsed.error });
      return;
    }

    // Replacement is intentional: callers must submit the complete desired
    // configuration, including any optional values they want to preserve.
    const { rows } = await db.query(
      `UPDATE sites
       SET last_form_values = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, project_name, domain, last_form_values`,
      [JSON.stringify(parsed.formValues), req.params.id],
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const project = withAutomationReady(rows[0]);
    res.json({ project, automation_ready: project.automation_ready });
  } catch (err) {
    console.error('PATCH /api/projects/:id/form-values error:', err);
    res.status(500).json({ error: 'Failed to save form values' });
  }
});

// ── GET /api/audits/compare?a=<id>&b=<id> ────────────────────────

projectsRouter.get('/audits/compare', async (req: Request, res: Response) => {
  const db = requireDb(res);
  if (!db) return;

  const idA = String(req.query.a ?? '');
  const idB = String(req.query.b ?? '');

  if (!idA || !idB) {
    res.status(400).json({ error: 'Query params a and b (audit run IDs) are required' });
    return;
  }
  if (idA === idB) {
    res.status(400).json({ error: 'a and b must be different audit run IDs' });
    return;
  }

  try {
    // Fetch both runs
    const runsRes = await db.query(
      `SELECT id, site_id, status, started_at, finished_at
       FROM audit_runs WHERE id = ANY($1::text[])`,
      [[idA, idB]],
    );

    const runMap = new Map(runsRes.rows.map(r => [r.id, r]));
    const runA = runMap.get(idA);
    const runB = runMap.get(idB);

    if (!runA) { res.status(404).json({ error: `Audit run ${idA} not found` }); return; }
    if (!runB) { res.status(404).json({ error: `Audit run ${idB} not found` }); return; }

    if (runA.site_id !== runB.site_id) {
      res.status(400).json({ error: 'Cannot compare audits from different projects' });
      return;
    }

    // Fetch results for both runs in one query
    const resultsRes = await db.query(
      `SELECT audit_run_id, url, status, data, recommendations
       FROM audit_results
       WHERE audit_run_id = ANY($1::text[])`,
      [[idA, idB]],
    );

    function buildSnapshot(runId: string, run: typeof runA): AuditSnapshot {
      const rows = resultsRes.rows.filter(r => r.audit_run_id === runId);
      let passed = 0, warnings = 0, failed = 0, critical = 0;
      let scoreSum = 0, scoreCount = 0;

      const pages: AuditPage[] = rows.map(r => {
        if (r.status === 'PASS')      passed++;
        else if (r.status === 'WARN') warnings++;
        else if (r.status === 'FAIL') failed++;

        const recs: AuditPage['recommendations'] = Array.isArray(r.recommendations)
          ? r.recommendations : [];
        critical += recs.filter(rec => rec.priority === 'P0').length;

        const rawScore = r.data?.layeredScore?.overall;
        if (rawScore != null) { scoreSum += Number(rawScore); scoreCount++; }

        return {
          url:             r.url,
          page_type:       r.data?.pageType ?? 'unknown',
          status:          r.status ?? 'FAIL',
          recommendations: recs,
        };
      });

      return {
        id:       runId,
        date:     run.started_at,
        score:    scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 10) / 10 : null,
        passed,
        warnings,
        failed,
        critical,
        pages,
      };
    }

    const snapshotA = buildSnapshot(idA, runA);
    const snapshotB = buildSnapshot(idB, runB);

    const comparison = compareAudits(snapshotA, snapshotB);

    res.json({ comparison });
  } catch (err) {
    console.error('GET /api/audits/compare error:', err);
    res.status(500).json({ error: 'Failed to compare audits' });
  }
});
