/**
 * AuditHistoryPanel
 *
 * Collapsible panel shown below the ProjectSelector when a project
 * is active. Displays the paginated list of past audit runs and lets
 * the user reload a previous audit result into the analyzer display.
 *
 * "Load" fetches GET /api/audit-runs/:id/results — the same endpoint
 * the analyzer uses during live polling — so the result is fed into
 * the existing SEOAgent renderer without any changes to that code.
 *
 * This component never calls the audit engine.
 */

import { useState, useEffect, useCallback } from 'react';
import { History, ChevronDown, ChevronUp, CheckCircle, XCircle, Loader2, Clock } from 'lucide-react';

interface AuditHistorySummary {
  audit_id: string;
  project_id: string;
  audit_date: string;
  status: string;
  duration_ms: number | null;
  results: {
    score: number | null;
    passed: number;
    warnings: number;
    failed: number;
    critical: number;
  };
}

interface AuditRunData {
  id: string;
  status: string;
  siteChecks: Record<string, unknown> | null;
  siteRecommendations: unknown[];
  resultsByType: Record<string, unknown[]>;
  results: unknown[];
}

interface AuditHistoryPanelProps {
  projectId: string;
  projectName: string;
  apiBase: string;
  /** Called when the user loads a past audit — parent passes it to SEOAgent */
  onLoadAudit: (data: AuditRunData) => void;
}

export default function AuditHistoryPanel({
  projectId,
  projectName,
  apiBase,
  onLoadAudit,
}: AuditHistoryPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [audits, setAudits] = useState<AuditHistorySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const fetchHistory = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/projects/${projectId}/audits?page=${p}&limit=10`);
      if (res.ok) {
        const data = await res.json() as {
          audits: AuditHistorySummary[];
          pagination: { pages: number };
        };
        setAudits(data.audits ?? []);
        setTotalPages(data.pagination?.pages ?? 1);
      }
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [apiBase, projectId]);

  useEffect(() => {
    if (expanded) fetchHistory(page);
  }, [expanded, page, fetchHistory]);

  // Reset when project changes
  useEffect(() => {
    setAudits([]);
    setPage(1);
    setExpanded(false);
  }, [projectId]);

  const handleLoad = async (auditId: string) => {
    setLoadingId(auditId);
    try {
      const res = await fetch(`${apiBase}/api/audit-runs/${auditId}/results`);
      if (res.ok) {
        const data = await res.json() as AuditRunData;
        onLoadAudit(data);
      }
    } catch { /* ignore */ } finally {
      setLoadingId(null);
    }
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

  const formatDuration = (ms: number | null) => {
    if (!ms) return '';
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    return `${Math.round(ms / 60_000)}m`;
  };

  const statusIcon = (status: string) => {
    if (status === 'COMPLETED') return <CheckCircle size={13} className="text-green-500" />;
    if (status === 'FAILED')    return <XCircle size={13} className="text-red-400" />;
    return <Loader2 size={13} className="text-blue-400 animate-spin" />;
  };

  return (
    <div className="mt-3 border border-slate-200 rounded-lg bg-white overflow-hidden">
      {/* Toggle header */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50"
      >
        <span className="flex items-center gap-2">
          <History size={14} className="text-slate-400" />
          Audit history for <strong className="text-slate-700">{projectName}</strong>
        </span>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {/* History table */}
      {expanded && (
        <div className="border-t border-slate-100">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-slate-400">
              <Loader2 size={14} className="animate-spin" /> Loading history…
            </div>
          ) : audits.length === 0 ? (
            <div className="py-6 text-center text-sm text-slate-400">
              No completed audits yet for this project.
            </div>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-100">
                  <tr>
                    <th className="text-left px-4 py-2 text-xs font-medium text-slate-500">
                      <span className="flex items-center gap-1"><Clock size={11} /> Date</span>
                    </th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-slate-500">Status</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-slate-500">Score</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-slate-500">Pass / Warn / Fail</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-slate-500">Critical</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {audits.map(a => (
                    <tr key={a.audit_id} className="hover:bg-slate-50">
                      <td className="px-4 py-2 text-xs text-slate-600 whitespace-nowrap">
                        {formatDate(a.audit_date)}
                        {a.duration_ms && (
                          <span className="text-slate-400 ml-1">({formatDuration(a.duration_ms)})</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <span className="flex items-center gap-1 text-xs">
                          {statusIcon(a.status)}
                          {a.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-600">
                        {a.results.score != null ? a.results.score : '—'}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        <span className="text-green-600">{a.results.passed}</span>
                        {' / '}
                        <span className="text-amber-500">{a.results.warnings}</span>
                        {' / '}
                        <span className="text-red-500">{a.results.failed}</span>
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {a.results.critical > 0
                          ? <span className="text-red-600 font-medium">{a.results.critical}</span>
                          : <span className="text-slate-400">0</span>}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {a.status === 'COMPLETED' && (
                          <button
                            onClick={() => handleLoad(a.audit_id)}
                            disabled={loadingId === a.audit_id}
                            className="text-xs text-blue-600 border border-blue-200 rounded px-2.5 py-1 hover:bg-blue-50 disabled:opacity-50"
                          >
                            {loadingId === a.audit_id ? 'Loading…' : 'Load'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-2 border-t border-slate-100 text-xs text-slate-500">
                  <button
                    disabled={page <= 1}
                    onClick={() => setPage(p => p - 1)}
                    className="disabled:opacity-40 hover:text-slate-700"
                  >
                    ← Previous
                  </button>
                  <span>Page {page} of {totalPages}</span>
                  <button
                    disabled={page >= totalPages}
                    onClick={() => setPage(p => p + 1)}
                    className="disabled:opacity-40 hover:text-slate-700"
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
