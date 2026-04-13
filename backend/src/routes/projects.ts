/**
 * Project management & audit history API
 *
 * Mounts under /api in server/index.js.
 * All endpoints require a configured DATABASE_URL — returns 501 otherwise.
 * The audit engine (auditRunsSimple.ts) is never imported or modified here.
 *
 * Endpoints:
 *   GET    /api/projects                          — list all projects
 *   POST   /api/projects                          — create / register project
 *   GET    /api/projects/:id                      — single project + stats
 *   PATCH  /api/projects/:id                      — rename project
 *   DELETE /api/projects/:id                      — delete project (cascades)
 *   GET    /api/projects/:id/audits               — paginated audit history
 *   GET    /api/projects/:id/audits/latest        — latest completed audit
 *   GET    /api/audits/compare?a=<id>&b=<id>      — diff two audit runs
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../lib/db.js';
import { compareAudits, AuditSnapshot, AuditPage } from '../lib/compareAudits.js';

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
        s.created_at,
        s.last_audit_at,
        COUNT(ar.id)::int                                             AS audit_count,
        COUNT(ar.id) FILTER (WHERE ar.status = 'COMPLETED')::int     AS completed_count
      FROM sites s
      LEFT JOIN audit_runs ar ON ar.site_id = s.id
      GROUP BY s.id
      ORDER BY s.last_audit_at DESC NULLS LAST, s.created_at DESC
    `);
    res.json({ projects: rows });
  } catch (err) {
    console.error('GET /api/projects error:', err);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// ── POST /api/projects ────────────────────────────────────────────

projectsRouter.post('/projects', async (req: Request, res: Response) => {
  const db = requireDb(res);
  if (!db) return;

  const { project_name, website_url } = req.body ?? {};

  if (!website_url) {
    res.status(400).json({ error: 'website_url is required' });
    return;
  }

  let domain: string;
  try {
    domain = new URL(website_url).hostname;
  } catch {
    res.status(400).json({ error: 'Invalid website_url' });
    return;
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO sites (domain, project_name, website_url, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (domain) DO UPDATE
         SET project_name = EXCLUDED.project_name,
             website_url  = EXCLUDED.website_url,
             updated_at   = NOW()
       RETURNING *`,
      [domain, project_name ?? domain, website_url],
    );
    res.status(201).json({ project: rows[0] });
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
    const { rows } = await db.query(
      `SELECT
         s.*,
         COUNT(ar.id)::int                                           AS audit_count,
         COUNT(ar.id) FILTER (WHERE ar.status = 'COMPLETED')::int   AS completed_count,
         COUNT(ar.id) FILTER (WHERE ar.status = 'RUNNING')::int     AS running_count
       FROM sites s
       LEFT JOIN audit_runs ar ON ar.site_id = s.id
       WHERE s.id = $1
       GROUP BY s.id`,
      [req.params.id],
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ project: rows[0] });
  } catch (err) {
    console.error('GET /api/projects/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

// ── PATCH /api/projects/:id ───────────────────────────────────────

projectsRouter.patch('/projects/:id', async (req: Request, res: Response) => {
  const db = requireDb(res);
  if (!db) return;

  const { project_name } = req.body ?? {};
  if (!project_name || typeof project_name !== 'string' || !project_name.trim()) {
    res.status(400).json({ error: 'project_name is required' });
    return;
  }

  try {
    const { rows } = await db.query(
      `UPDATE sites
       SET project_name = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [project_name.trim(), req.params.id],
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

  const allowed = ['homeUrl', 'articleUrl', 'sectionUrl', 'tagUrl', 'searchUrl', 'authorUrl', 'videoArticleUrl'];
  const body = req.body ?? {};

  // Accept only known keys; discard everything else
  const formValues: Record<string, string> = {};
  for (const key of allowed) {
    if (typeof body[key] === 'string' && body[key].trim()) {
      formValues[key] = body[key].trim();
    }
  }

  if (!formValues.homeUrl) {
    res.status(400).json({ error: 'homeUrl is required' });
    return;
  }

  try {
    const { rows } = await db.query(
      `UPDATE sites
       SET last_form_values = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, project_name, domain, last_form_values`,
      [JSON.stringify(formValues), req.params.id],
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ project: rows[0] });
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
