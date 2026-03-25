import { useState } from 'react';
import { Newspaper, AlertCircle, CheckCircle, Loader2, AlertTriangle, Info, ChevronDown, ChevronUp } from 'lucide-react';

interface ModuleResult {
  module: string;
  priority?: string;
  status: string;
  score?: number;
  issues?: Array<{ level: string; message: string }>;
  [key: string]: unknown;
}

interface NewsSEOResult {
  url: string;
  status: string;
  overall_score: number;
  modules: Record<string, ModuleResult>;
  duration_ms: number;
  error?: string;
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'PASS') return <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-green-100 text-green-700">PASS</span>;
  if (status === 'WARNING') return <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-100 text-amber-700">WARNING</span>;
  if (status === 'FAIL') return <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-red-100 text-red-700">FAIL</span>;
  return <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-slate-100 text-slate-600">{status}</span>;
}

function PriorityBadge({ priority }: { priority?: string }) {
  if (!priority) return null;
  const colors: Record<string, string> = {
    critical: 'bg-red-50 text-red-700',
    high: 'bg-orange-50 text-orange-700',
    medium: 'bg-blue-50 text-blue-700',
    low: 'bg-slate-50 text-slate-600',
  };
  return <span className={`px-2 py-0.5 text-xs rounded-full ${colors[priority] || 'bg-slate-50 text-slate-600'}`}>{priority}</span>;
}

function ScoreRing({ score }: { score: number }) {
  const color = score >= 80 ? 'text-green-600' : score >= 50 ? 'text-amber-500' : 'text-red-600';
  const bg = score >= 80 ? 'bg-green-50' : score >= 50 ? 'bg-amber-50' : 'bg-red-50';
  return (
    <div className={`${bg} rounded-lg p-3 text-center min-w-[80px]`}>
      <p className={`text-2xl font-bold ${color}`}>{score}</p>
      <p className="text-xs text-slate-500">/ 100</p>
    </div>
  );
}

function IssuesList({ issues }: { issues?: Array<{ level: string; message: string }> }) {
  if (!issues || issues.length === 0) return <p className="text-sm text-green-600">No issues detected</p>;

  const iconMap: Record<string, React.ReactNode> = {
    critical: <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />,
    high: <AlertTriangle className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" />,
    medium: <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />,
    low: <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />,
    info: <Info className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />,
  };

  const bgMap: Record<string, string> = {
    critical: 'bg-red-50',
    high: 'bg-orange-50',
    medium: 'bg-amber-50',
    low: 'bg-blue-50',
    info: 'bg-slate-50',
  };

  return (
    <div className="space-y-1.5 max-h-60 overflow-y-auto">
      {issues.slice(0, 20).map((issue, i) => (
        <div key={i} className={`flex items-start gap-2 ${bgMap[issue.level] || 'bg-slate-50'} px-3 py-2 rounded-lg`}>
          {iconMap[issue.level] || iconMap.info}
          <p className="text-xs text-slate-700">{issue.message}</p>
        </div>
      ))}
    </div>
  );
}

function ModuleCard({ title, data }: { title: string; data: ModuleResult }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-slate-50 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <StatusBadge status={data.status} />
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <PriorityBadge priority={data.priority} />
        </div>
        <div className="flex items-center gap-3">
          {data.score !== undefined && <ScoreRing score={data.score} />}
          {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-4 border-t border-slate-100 pt-3">
          <IssuesList issues={data.issues} />
          {/* Module-specific summary data */}
          {data.module === 'news_sitemap' && (
            <div className="mt-3 grid grid-cols-3 gap-2">
              <div className="bg-slate-50 rounded p-2 text-center">
                <p className="text-xs text-slate-500">Sitemaps</p>
                <p className="text-lg font-bold text-slate-900">{(data.sitemaps_found as string[])?.length || 0}</p>
              </div>
              <div className="bg-slate-50 rounded p-2 text-center">
                <p className="text-xs text-slate-500">News URLs</p>
                <p className="text-lg font-bold text-slate-900">{(data.news_urls as number) || 0}</p>
              </div>
              <div className="bg-slate-50 rounded p-2 text-center">
                <p className="text-xs text-slate-500">Freshness</p>
                <p className="text-lg font-bold text-slate-900">{(data.freshness_score as number) || 0}%</p>
              </div>
            </div>
          )}
          {data.module === 'article_schema' && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="bg-slate-50 rounded p-2 text-center">
                <p className="text-xs text-slate-500">Schemas Found</p>
                <p className="text-lg font-bold text-slate-900">{(data.schemas_found as number) || 0}</p>
              </div>
              <div className="bg-slate-50 rounded p-2 text-center">
                <p className="text-xs text-slate-500">Article Schemas</p>
                <p className="text-lg font-bold text-slate-900">{(data.article_schemas as unknown[])?.length || 0}</p>
              </div>
            </div>
          )}
          {data.module === 'canonical_consistency' && (
            <div className="mt-3 space-y-1 text-xs">
              {(data.canonical as Record<string, unknown>)?.declared && (
                <p className="text-slate-600">Canonical: <span className="font-mono text-slate-800">{String((data.canonical as Record<string, unknown>).declared).substring(0, 80)}</span></p>
              )}
              <p className="text-slate-600">Self-referencing: <span className="font-semibold">{(data.canonical as Record<string, unknown>)?.is_self_referencing ? 'Yes' : 'No'}</span></p>
              <p className="text-slate-600">AMP detected: <span className="font-semibold">{(data.amp as Record<string, unknown>)?.detected ? 'Yes' : 'No'}</span></p>
            </div>
          )}
          {data.module === 'core_web_vitals' && (
            <div className="mt-3 grid grid-cols-3 gap-2">
              {['lcp', 'cls', 'inp'].map(metric => {
                const m = data[metric] as Record<string, unknown> | undefined;
                if (!m) return null;
                const score = String(m.score || 'unknown');
                const color = score === 'good' ? 'text-green-600 bg-green-50' : score === 'needs_improvement' ? 'text-amber-600 bg-amber-50' : 'text-red-600 bg-red-50';
                return (
                  <div key={metric} className={`rounded p-2 text-center ${color}`}>
                    <p className="text-xs uppercase font-medium">{metric}</p>
                    <p className="text-sm font-bold">{score.replace('_', ' ')}</p>
                  </div>
                );
              })}
            </div>
          )}
          {data.module === 'amp_validator' && (
            <div className="mt-3 text-xs text-slate-600">
              <p>AMP detected: <span className="font-semibold">{(data.amp_detected as boolean) ? 'Yes' : 'No'}</span></p>
              {(data.validation as Record<string, unknown>)?.is_valid_amp !== null && (
                <p>Valid AMP: <span className="font-semibold">{(data.validation as Record<string, unknown>)?.is_valid_amp ? 'Yes' : 'No'}</span></p>
              )}
            </div>
          )}
          {data.module === 'freshness_analyzer' && (
            <div className="mt-3 space-y-1 text-xs text-slate-600">
              <p>Freshness: <span className="font-semibold capitalize">{String(data.freshness_category || 'unknown')}</span></p>
              {(data.age as Record<string, unknown>)?.days_since_published != null && (
                <p>Published: <span className="font-semibold">{String((data.age as Record<string, unknown>).days_since_published)} days ago</span></p>
              )}
              {(data.age as Record<string, unknown>)?.days_since_modified != null && (
                <p>Modified: <span className="font-semibold">{String((data.age as Record<string, unknown>).days_since_modified)} days ago</span></p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const MODULE_LABELS: Record<string, string> = {
  news_sitemap: 'News Sitemap Engine',
  article_schema: 'Article Schema Analyzer',
  canonical_consistency: 'Canonical Consistency',
  core_web_vitals: 'Core Web Vitals',
  amp_validator: 'AMP Validator',
  freshness: 'Freshness Signals',
};

export default function NewsSEO() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<NewsSEOResult | null>(null);
  const [error, setError] = useState('');

  const analyzeNewsSEO = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!url.trim()) {
      setError('Please enter a valid URL');
      return;
    }

    setLoading(true);
    setError('');
    setResult(null);

    try {
      const apiBase = import.meta.env.VITE_API_BASE_URL || '';
      const apiUrl = `${apiBase}/api/news-seo`;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || `Analysis failed (HTTP ${response.status})`);
        return;
      }

      setResult(data);
    } catch {
      setError('Failed to analyze URL. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 to-purple-100">
      <div className="max-w-6xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-violet-600 rounded-2xl mb-4">
            <Newspaper className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-4xl font-bold text-slate-900 mb-3">
            News SEO Analyzer
          </h1>
          <p className="text-lg text-slate-600">
            Comprehensive news SEO audit: sitemaps, schema, canonicals, vitals, AMP &amp; freshness
          </p>
        </div>

        {/* Input Form */}
        <div className="bg-white rounded-2xl shadow-lg p-8 mb-8">
          <form onSubmit={analyzeNewsSEO} className="space-y-4">
            <div>
              <label htmlFor="news-url" className="block text-sm font-medium text-slate-700 mb-2">
                Enter URL to Analyze
              </label>
              <input
                id="news-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/article"
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent outline-none transition-all"
                disabled={loading}
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-red-600 bg-red-50 px-4 py-3 rounded-lg">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <p className="text-sm">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-violet-600 hover:bg-violet-700 text-white font-medium py-3 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Analyzing News SEO...
                </>
              ) : (
                <>
                  <Newspaper className="w-5 h-5" />
                  Analyze News SEO
                </>
              )}
            </button>
          </form>
        </div>

        {/* Results */}
        {result && (
          <div className="space-y-6">
            {/* Overall Score */}
            <div className="bg-white rounded-2xl shadow-lg p-8">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  {result.status === 'PASS' ? (
                    <CheckCircle className="w-7 h-7 text-green-600" />
                  ) : result.status === 'WARNING' ? (
                    <AlertTriangle className="w-7 h-7 text-amber-500" />
                  ) : (
                    <AlertCircle className="w-7 h-7 text-red-600" />
                  )}
                  <div>
                    <h2 className="text-2xl font-bold text-slate-900">News SEO Report</h2>
                    <p className="text-sm text-slate-500 break-all">{result.url}</p>
                  </div>
                </div>
                <StatusBadge status={result.status} />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className={`rounded-lg p-4 text-center ${
                  result.overall_score >= 80 ? 'bg-green-50' :
                  result.overall_score >= 50 ? 'bg-amber-50' : 'bg-red-50'
                }`}>
                  <p className="text-sm text-slate-600 mb-1">Overall Score</p>
                  <p className={`text-4xl font-bold ${
                    result.overall_score >= 80 ? 'text-green-600' :
                    result.overall_score >= 50 ? 'text-amber-600' : 'text-red-600'
                  }`}>{result.overall_score}</p>
                </div>
                <div className="bg-violet-50 rounded-lg p-4 text-center">
                  <p className="text-sm text-violet-600 mb-1">Modules Run</p>
                  <p className="text-4xl font-bold text-violet-900">{Object.keys(result.modules).length}</p>
                </div>
                <div className="bg-slate-50 rounded-lg p-4 text-center">
                  <p className="text-sm text-slate-600 mb-1">Duration</p>
                  <p className="text-4xl font-bold text-slate-900">{(result.duration_ms / 1000).toFixed(1)}s</p>
                </div>
              </div>
            </div>

            {/* Module Results */}
            <div className="space-y-3">
              {Object.entries(result.modules).map(([key, data]) => (
                <ModuleCard
                  key={key}
                  title={MODULE_LABELS[key] || key}
                  data={data}
                />
              ))}
            </div>

            {/* Raw JSON */}
            <div className="bg-slate-900 rounded-2xl shadow-lg p-6">
              <h3 className="text-lg font-semibold text-white mb-3">Raw JSON Output</h3>
              <pre className="bg-slate-800 text-slate-100 p-4 rounded-lg overflow-x-auto text-xs max-h-96 overflow-y-auto">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
