/**
 * compareAudits — pure diff function for audit results.
 *
 * Accepts two AuditSnapshot objects (fetched from DB by the caller)
 * and returns a structured comparison. No DB calls, no side effects.
 *
 * Convention: auditA = older baseline, auditB = newer snapshot.
 * Positive deltas mean improvement (score went up, failed went down, etc.).
 */

export interface AuditPage {
  url: string;
  page_type: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  recommendations: Array<{
    priority: string; // 'P0' | 'P1' | 'P2'
    area: string;
    message: string;
  }>;
}

export interface AuditSnapshot {
  id: string;
  date: string; // ISO timestamp
  score: number | null;
  passed: number;
  warnings: number;
  failed: number;
  critical: number; // P0 recommendation count
  pages: AuditPage[];
}

export interface PageDiff {
  url: string;
  page_type: string;
  status_a: 'PASS' | 'WARN' | 'FAIL' | null; // null = page not in A
  status_b: 'PASS' | 'WARN' | 'FAIL' | null; // null = page not in B
}

export interface ComparisonResult {
  audit_a: { id: string; date: string; score: number | null };
  audit_b: { id: string; date: string; score: number | null };
  /** positive = score improved */
  score_delta: number | null;
  passed_delta: number;
  warnings_delta: number;
  failed_delta: number;
  critical_delta: number;
  /** Pages where status improved (FAIL→WARN, FAIL→PASS, WARN→PASS) */
  pages_improved: PageDiff[];
  /** Pages where status regressed (PASS→WARN, PASS→FAIL, WARN→FAIL) */
  pages_regressed: PageDiff[];
  /** Pages present in both audits with the same status */
  pages_unchanged: PageDiff[];
  /** URLs present in B but not in A */
  pages_added: string[];
  /** URLs present in A but not in B */
  pages_removed: string[];
  /** P0 issue messages that appear in B but not in A */
  new_critical_issues: string[];
  /** P0 issue messages that appeared in A but are gone in B */
  resolved_critical_issues: string[];
}

// Higher ordinal = better status
const STATUS_RANK: Record<string, number> = { FAIL: 0, WARN: 1, PASS: 2 };

function rankOf(status: string): number {
  return STATUS_RANK[status] ?? -1;
}

/**
 * Compare two audit snapshots. auditA is the baseline (older), auditB is newer.
 */
export function compareAudits(
  auditA: AuditSnapshot,
  auditB: AuditSnapshot,
): ComparisonResult {
  // ── Scalar deltas ─────────────────────────────────────────────
  const score_delta =
    auditA.score != null && auditB.score != null
      ? Math.round((auditB.score - auditA.score) * 10) / 10
      : null;

  // ── Build page lookup maps keyed by URL ───────────────────────
  const mapA = new Map<string, AuditPage>(auditA.pages.map(p => [p.url, p]));
  const mapB = new Map<string, AuditPage>(auditB.pages.map(p => [p.url, p]));

  const pages_improved: PageDiff[] = [];
  const pages_regressed: PageDiff[] = [];
  const pages_unchanged: PageDiff[] = [];
  const pages_added: string[] = [];
  const pages_removed: string[] = [];

  // Pages in B — classify vs A
  for (const [url, pageB] of mapB) {
    const pageA = mapA.get(url);
    if (!pageA) {
      pages_added.push(url);
      continue;
    }
    const diff: PageDiff = {
      url,
      page_type: pageB.page_type,
      status_a: pageA.status,
      status_b: pageB.status,
    };
    const rankA = rankOf(pageA.status);
    const rankB = rankOf(pageB.status);
    if (rankB > rankA) pages_improved.push(diff);
    else if (rankB < rankA) pages_regressed.push(diff);
    else pages_unchanged.push(diff);
  }

  // Pages in A but not in B
  for (const url of mapA.keys()) {
    if (!mapB.has(url)) pages_removed.push(url);
  }

  // ── P0 issue diff ─────────────────────────────────────────────
  const p0MessagesA = new Set<string>(
    auditA.pages.flatMap(p =>
      p.recommendations
        .filter(r => r.priority === 'P0')
        .map(r => r.message),
    ),
  );
  const p0MessagesB = new Set<string>(
    auditB.pages.flatMap(p =>
      p.recommendations
        .filter(r => r.priority === 'P0')
        .map(r => r.message),
    ),
  );

  const new_critical_issues = [...p0MessagesB].filter(m => !p0MessagesA.has(m));
  const resolved_critical_issues = [...p0MessagesA].filter(m => !p0MessagesB.has(m));

  return {
    audit_a: { id: auditA.id, date: auditA.date, score: auditA.score },
    audit_b: { id: auditB.id, date: auditB.date, score: auditB.score },
    score_delta,
    passed_delta:   auditB.passed   - auditA.passed,
    warnings_delta: auditB.warnings - auditA.warnings,
    failed_delta:   auditB.failed   - auditA.failed,
    critical_delta: auditB.critical - auditA.critical,
    pages_improved,
    pages_regressed,
    pages_unchanged,
    pages_added,
    pages_removed,
    new_critical_issues,
    resolved_critical_issues,
  };
}
