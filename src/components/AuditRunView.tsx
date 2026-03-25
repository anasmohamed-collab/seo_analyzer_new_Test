import { useState } from 'react';
import {
  CheckCircle, AlertTriangle, XCircle, ChevronDown, ChevronRight,
  Copy, Check, Shield, Map, Loader2, AlertCircle,
} from 'lucide-react';

/* ── Types ────────────────────────────────────────────────────── */

interface Recommendation {
  priority: string;
  area: string;
  message: string;
  fixHint: string;
}

interface AuditResultRow {
  id: string;
  url: string;
  status: string | null;
  data: Record<string, unknown> | null;
  recommendations: Recommendation[] | null;
}

interface AuditRunData {
  id: string;
  status: string;
  siteChecks: Record<string, unknown> | null;
  siteRecommendations: Recommendation[];
  resultsByType: Record<string, AuditResultRow[]>;
  results: AuditResultRow[];
}

/* ── Small UI helpers ─────────────────────────────────────────── */

function StatusBadge({ status }: { status: string | null }) {
  if (status === 'PASS') return <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded-full"><CheckCircle className="w-3 h-3" />PASS</span>;
  if (status === 'WARN') return <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full"><AlertTriangle className="w-3 h-3" />WARN</span>;
  if (status === 'FAIL') return <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-100 px-2 py-0.5 rounded-full"><XCircle className="w-3 h-3" />FAIL</span>;
  return <span className="text-xs text-slate-500">—</span>;
}

function SiteStatusBadge({ label, status }: { label: string; status: string }) {
  const color =
    status === 'FOUND' ? 'bg-green-100 text-green-700' :
    status === 'DISCOVERED' ? 'bg-yellow-100 text-yellow-700' :
    status === 'NOT_FOUND' || status === 'INVALID_XML' || status === 'INVALID_FORMAT' ? 'bg-red-100 text-red-700' :
    status === 'BLOCKED' || status === 'SOFT_404' ? 'bg-orange-100 text-orange-700' :
    'bg-slate-100 text-slate-600';
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-slate-600">{label}:</span>
      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${color}`}>{status}</span>
    </div>
  );
}

function SignalDot({ ok }: { ok: boolean | null | undefined }) {
  if (ok === null || ok === undefined) return <span className="w-2 h-2 rounded-full bg-slate-200 inline-block" />;
  return ok
    ? <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
    : <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />;
}

/* ── Site checks summary ──────────────────────────────────────── */

function SiteChecksSummary({ siteChecks, siteRecs }: { siteChecks: Record<string, unknown> | null; siteRecs: Recommendation[] }) {
  if (!siteChecks) return null;
  const robots = siteChecks.robots as Record<string, unknown> | undefined;
  const sitemap = siteChecks.sitemap as Record<string, unknown> | undefined;

  const notes = [
    ...(robots?.notes as string[] ?? []),
    ...(sitemap?.errors as string[] ?? []),
    ...(sitemap?.warnings as string[] ?? []),
  ];

  return (
    <div className="bg-white rounded-2xl shadow-lg p-6">
      <div className="flex items-center gap-2 mb-4">
        <Shield className="w-5 h-5 text-blue-600" />
        <h3 className="text-base font-semibold text-slate-900">Site-Level Checks</h3>
      </div>
      <div className="flex flex-wrap gap-4 mb-3">
        {robots && <SiteStatusBadge label="robots.txt" status={String(robots.status)} />}
        {sitemap && <SiteStatusBadge label="Sitemap" status={String(sitemap.status)} />}
        {sitemap?.type != null && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-600">Type:</span>
            <span className="text-xs font-mono bg-slate-100 px-1.5 py-0.5 rounded">{String(sitemap.type)}</span>
          </div>
        )}
      </div>
      {notes.length > 0 && (
        <div className="space-y-1 mt-2">
          {notes.map((n, i) => (
            <p key={i} className="text-xs text-slate-600 bg-slate-50 px-3 py-1.5 rounded">{n}</p>
          ))}
        </div>
      )}
      {siteRecs.length > 0 && (
        <div className="mt-3 space-y-1">
          {siteRecs.map((r, i) => (
            <div key={i} className="flex items-start gap-2 text-xs bg-amber-50 px-3 py-1.5 rounded">
              <span className="font-semibold text-amber-700 shrink-0">{r.priority}</span>
              <span className="text-slate-700">{r.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Expandable result row ────────────────────────────────────── */

function ResultRow({ row }: { row: AuditResultRow }) {
  const [open, setOpen] = useState(false);
  const data = row.data;
  const pageType = (data?.pageType as string) ?? '—';
  const canonical = data?.canonical as Record<string, unknown> | null;
  const schema = data?.structuredData as Record<string, unknown> | null;
  const meta = data?.contentMeta as Record<string, unknown> | null;

  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
      >
        {open ? <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />}
        <span className="text-xs font-mono bg-slate-100 px-1.5 py-0.5 rounded shrink-0">{pageType}</span>
        <span className="text-sm text-slate-700 truncate flex-1 font-mono">{row.url}</span>
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-1.5 text-[10px] text-slate-500" title="canonical / schema / meta">
            <SignalDot ok={canonical ? !!(canonical.exists && canonical.match) : undefined} />
            <SignalDot ok={schema ? schema.status === 'PASS' : undefined} />
            <SignalDot ok={meta ? !(meta.robotsMeta as Record<string, unknown>)?.noindex && (meta.h1Ok as boolean) : undefined} />
          </div>
          <StatusBadge status={row.status} />
        </div>
      </button>
      {open && (
        <div className="px-4 pb-4">
          {row.recommendations && row.recommendations.length > 0 && (
            <div className="mb-3 space-y-1">
              {row.recommendations.map((r, i) => (
                <div key={i} className="flex items-start gap-2 text-xs bg-amber-50 px-3 py-1.5 rounded">
                  <span className="font-semibold text-amber-700 shrink-0">{r.priority}</span>
                  <span className="text-slate-500 shrink-0">[{r.area}]</span>
                  <div>
                    <span className="text-slate-700">{r.message}</span>
                    <span className="text-blue-600 ml-1">{r.fixHint}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <details className="bg-slate-900 rounded-lg overflow-hidden">
            <summary className="px-3 py-2 text-white text-xs cursor-pointer hover:bg-slate-800">
              Raw data
            </summary>
            <pre className="bg-slate-800 text-slate-100 p-3 overflow-x-auto text-[10px] max-h-64 overflow-y-auto">
              {JSON.stringify(data, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

/* ── Recommendations panel ────────────────────────────────────── */

function RecommendationsPanel({ allRecs }: { allRecs: Recommendation[] }) {
  const [copied, setCopied] = useState(false);

  if (allRecs.length === 0) return null;

  const byPriority: Record<string, Recommendation[]> = {};
  for (const r of allRecs) {
    if (!byPriority[r.priority]) byPriority[r.priority] = [];
    byPriority[r.priority].push(r);
  }

  const ordered = ['P0', 'P1', 'P2'].filter(p => byPriority[p]);

  const copyChecklist = () => {
    const lines: string[] = [];
    for (const p of ordered) {
      lines.push(`--- ${p} ---`);
      for (const r of byPriority[p]) {
        lines.push(`[ ] [${r.area}] ${r.message} — ${r.fixHint}`);
      }
      lines.push('');
    }
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const priorityColors: Record<string, string> = {
    P0: 'bg-red-50 border-red-200',
    P1: 'bg-amber-50 border-amber-200',
    P2: 'bg-blue-50 border-blue-200',
  };

  return (
    <div className="bg-white rounded-2xl shadow-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Map className="w-5 h-5 text-violet-600" />
          <h3 className="text-base font-semibold text-slate-900">Recommendations</h3>
          <span className="text-xs bg-slate-100 px-2 py-0.5 rounded-full text-slate-600">{allRecs.length}</span>
        </div>
        <button
          onClick={copyChecklist}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied!' : 'Copy checklist'}
        </button>
      </div>

      <div className="space-y-4">
        {ordered.map(p => (
          <div key={p}>
            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">{p} — {p === 'P0' ? 'Critical' : p === 'P1' ? 'Important' : 'Nice to have'}</h4>
            <div className="space-y-1">
              {byPriority[p].map((r, i) => (
                <div key={i} className={`flex items-start gap-2 text-xs border px-3 py-2 rounded-lg ${priorityColors[p] ?? 'bg-slate-50 border-slate-200'}`}>
                  <span className="font-mono text-slate-500 shrink-0">[{r.area}]</span>
                  <div>
                    <span className="text-slate-800 font-medium">{r.message}</span>
                    <br />
                    <span className="text-blue-600">{r.fixHint}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Main component ───────────────────────────────────────────── */

export default function AuditRunView() {
  const [runId, setRunId] = useState('');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<AuditRunData | null>(null);
  const [error, setError] = useState('');

  const fetchRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!runId.trim()) return;

    setLoading(true);
    setError('');
    setData(null);

    try {
      const apiBase = import.meta.env.VITE_API_BASE_URL || '';
      const res = await fetch(`${apiBase}/api/audit-runs/${runId.trim()}/results`);
      if (!res.ok) {
        setError(`HTTP ${res.status}: ${(await res.json()).error ?? 'Not found'}`);
        return;
      }
      setData(await res.json());
    } catch {
      setError('Failed to fetch audit run.');
    } finally {
      setLoading(false);
    }
  };

  // Collect all recommendations across site + results
  const allRecs: Recommendation[] = [];
  if (data) {
    for (const r of data.siteRecommendations) allRecs.push(r);
    for (const row of data.results) {
      if (row.recommendations) {
        for (const r of row.recommendations) allRecs.push(r);
      }
    }
  }

  // Stats
  const passCount = data?.results.filter(r => r.status === 'PASS').length ?? 0;
  const warnCount = data?.results.filter(r => r.status === 'WARN').length ?? 0;
  const failCount = data?.results.filter(r => r.status === 'FAIL').length ?? 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-indigo-50">
      <div className="max-w-6xl mx-auto px-4 py-12">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Audit Run Viewer</h1>
          <p className="text-slate-600 text-sm">View site checks, per-URL results, and recommendations</p>
        </div>

        {/* Input */}
        <div className="bg-white rounded-2xl shadow-lg p-6 mb-8">
          <form onSubmit={fetchRun} className="flex gap-3">
            <input
              type="text"
              value={runId}
              onChange={e => setRunId(e.target.value)}
              placeholder="Audit Run ID"
              className="flex-1 px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none text-sm"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading}
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3 px-6 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Load
            </button>
          </form>
          {error && (
            <div className="flex items-center gap-2 text-red-600 bg-red-50 px-4 py-3 rounded-lg mt-3">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <p className="text-sm">{error}</p>
            </div>
          )}
        </div>

        {data && (
          <div className="space-y-6">
            {/* Summary bar */}
            <div className="bg-white rounded-2xl shadow-lg p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">Run {data.id.slice(0, 8)}...</h2>
                  <p className="text-xs text-slate-500">Status: {data.status}</p>
                </div>
                <div className="flex gap-4 text-center">
                  <div><p className="text-xl font-bold text-green-600">{passCount}</p><p className="text-[10px] text-slate-500">Pass</p></div>
                  <div><p className="text-xl font-bold text-amber-600">{warnCount}</p><p className="text-[10px] text-slate-500">Warn</p></div>
                  <div><p className="text-xl font-bold text-red-600">{failCount}</p><p className="text-[10px] text-slate-500">Fail</p></div>
                </div>
              </div>
            </div>

            {/* Site checks */}
            <SiteChecksSummary siteChecks={data.siteChecks} siteRecs={data.siteRecommendations} />

            {/* Per-URL results grouped by type */}
            {Object.entries(data.resultsByType).map(([type, rows]) => (
              <div key={type} className="bg-white rounded-2xl shadow-lg overflow-hidden">
                <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 flex items-center gap-2">
                  <span className="text-xs font-mono bg-slate-200 px-2 py-0.5 rounded">{type}</span>
                  <span className="text-xs text-slate-500">{rows.length} URL{rows.length !== 1 ? 's' : ''}</span>
                </div>
                {rows.map(row => <ResultRow key={row.id} row={row} />)}
              </div>
            ))}

            {/* Recommendations */}
            <RecommendationsPanel allRecs={allRecs} />
          </div>
        )}
      </div>
    </div>
  );
}
