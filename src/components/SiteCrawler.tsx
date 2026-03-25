import { useState } from 'react';
import { Globe, AlertCircle, CheckCircle, Loader2, AlertTriangle, Link2, Layers } from 'lucide-react';

interface AnalysisModule {
  module: string;
  status: string;
  score?: number;
  issues?: Array<{ level: string; message: string }>;
  [key: string]: unknown;
}

interface CrawlerResult {
  start_url: string;
  max_pages: number;
  total_pages_crawled: number;
  pages: any[];
  summary?: {
    errors: number;
    blocked: number;
    duplicates: number;
    duration_ms: number;
    robots_txt: string;
  };
  analysis?: {
    internal_linking?: AnalysisModule;
    crawl_depth?: AnalysisModule;
    duplicate_protection?: AnalysisModule;
  };
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'PASS') return <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-green-100 text-green-700">PASS</span>;
  if (status === 'WARNING') return <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-100 text-amber-700">WARNING</span>;
  if (status === 'FAIL') return <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-red-100 text-red-700">FAIL</span>;
  return null;
}

function AnalysisCard({ title, icon, data }: { title: string; icon: React.ReactNode; data: AnalysisModule }) {
  return (
    <div className="bg-white rounded-2xl shadow-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
        </div>
        <StatusBadge status={data.status} />
      </div>

      {data.score !== undefined && (
        <div className={`rounded-lg p-3 mb-4 text-center ${
          data.score >= 80 ? 'bg-green-50' : data.score >= 50 ? 'bg-amber-50' : 'bg-red-50'
        }`}>
          <p className={`text-3xl font-bold ${
            data.score >= 80 ? 'text-green-600' : data.score >= 50 ? 'text-amber-600' : 'text-red-600'
          }`}>{data.score}/100</p>
        </div>
      )}

      {data.issues && data.issues.length > 0 && (
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {data.issues.slice(0, 10).map((issue, i) => (
            <div key={i} className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs ${
              issue.level === 'critical' ? 'bg-red-50' :
              issue.level === 'high' ? 'bg-orange-50' :
              issue.level === 'medium' ? 'bg-amber-50' : 'bg-slate-50'
            }`}>
              {issue.level === 'critical' || issue.level === 'high' ? (
                <AlertTriangle className="w-3.5 h-3.5 text-orange-500 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
              )}
              <p className="text-slate-700">{issue.message}</p>
            </div>
          ))}
        </div>
      )}

      {(!data.issues || data.issues.length === 0) && (
        <p className="text-sm text-green-600">No issues detected</p>
      )}
    </div>
  );
}

export default function SiteCrawler() {
  const [url, setUrl] = useState('');
  const [maxPages, setMaxPages] = useState(50);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CrawlerResult | null>(null);
  const [error, setError] = useState('');

  const startCrawl = async (e: React.FormEvent) => {
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
      const apiUrl = `${apiBase}/api/seo-site-crawler`;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ start_url: url.trim(), max_pages: maxPages }),
      });

      const data = await response.json();
      setResult(data);
    } catch (err) {
      setError('Failed to crawl site. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-teal-100">
      <div className="max-w-6xl mx-auto px-4 py-12">
        <div className="text-center mb-12">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-emerald-600 rounded-2xl mb-4">
            <Globe className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-4xl font-bold text-slate-900 mb-3">
            SEO Site Crawler Agent
          </h1>
          <p className="text-lg text-slate-600">
            Crawl entire websites and analyze each page with comprehensive SEO intelligence
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-lg p-8 mb-8">
          <form onSubmit={startCrawl} className="space-y-4">
            <div>
              <label htmlFor="crawler-url" className="block text-sm font-medium text-slate-700 mb-2">
                Starting URL
              </label>
              <input
                id="crawler-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none transition-all"
                disabled={loading}
              />
            </div>

            <div>
              <label htmlFor="max-pages" className="block text-sm font-medium text-slate-700 mb-2">
                Maximum Pages (1-2000)
              </label>
              <input
                id="max-pages"
                type="number"
                min="1"
                max="2000"
                value={maxPages}
                onChange={(e) => setMaxPages(Math.min(2000, Math.max(1, parseInt(e.target.value) || 1)))}
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none transition-all"
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
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-3 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Crawling Site...
                </>
              ) : (
                <>
                  <Globe className="w-5 h-5" />
                  Start Crawl
                </>
              )}
            </button>
          </form>
        </div>

        {result && (
          <div className="space-y-6">
            <div className="bg-white rounded-2xl shadow-lg p-8">
              <div className="flex items-center gap-2 mb-4">
                <CheckCircle className="w-6 h-6 text-emerald-600" />
                <h2 className="text-2xl font-bold text-slate-900">Crawl Complete</h2>
              </div>
              <div className="grid grid-cols-3 gap-4 mb-4">
                <div className="bg-emerald-50 rounded-lg p-4">
                  <p className="text-sm text-emerald-600 mb-1">Total Pages Crawled</p>
                  <p className="text-3xl font-bold text-emerald-900">{result.total_pages_crawled}</p>
                </div>
                <div className="bg-teal-50 rounded-lg p-4">
                  <p className="text-sm text-teal-600 mb-1">Max Pages Limit</p>
                  <p className="text-3xl font-bold text-teal-900">{result.max_pages}</p>
                </div>
                <div className="bg-cyan-50 rounded-lg p-4">
                  <p className="text-sm text-cyan-600 mb-1">Success Rate</p>
                  <p className="text-3xl font-bold text-cyan-900">
                    {result.total_pages_crawled > 0 ? Math.round((result.pages.filter(p => p.status === 'success').length / result.total_pages_crawled) * 100) : 0}%
                  </p>
                </div>
              </div>
              {result.summary && (
                <div className="grid grid-cols-5 gap-2">
                  <div className="bg-slate-50 rounded p-2 text-center">
                    <p className="text-xs text-slate-500">Errors</p>
                    <p className="text-lg font-bold text-slate-900">{result.summary.errors}</p>
                  </div>
                  <div className="bg-slate-50 rounded p-2 text-center">
                    <p className="text-xs text-slate-500">Blocked</p>
                    <p className="text-lg font-bold text-slate-900">{result.summary.blocked}</p>
                  </div>
                  <div className="bg-slate-50 rounded p-2 text-center">
                    <p className="text-xs text-slate-500">Duplicates</p>
                    <p className="text-lg font-bold text-slate-900">{result.summary.duplicates}</p>
                  </div>
                  <div className="bg-slate-50 rounded p-2 text-center">
                    <p className="text-xs text-slate-500">Duration</p>
                    <p className="text-lg font-bold text-slate-900">{(result.summary.duration_ms / 1000).toFixed(1)}s</p>
                  </div>
                  <div className="bg-slate-50 rounded p-2 text-center">
                    <p className="text-xs text-slate-500">robots.txt</p>
                    <p className="text-lg font-bold text-slate-900">{result.summary.robots_txt === 'found' ? 'Found' : 'N/A'}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Post-crawl Analysis Modules */}
            {result.analysis && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {result.analysis.internal_linking && (
                  <AnalysisCard
                    title="Internal Linking"
                    icon={<Link2 className="w-5 h-5 text-emerald-600" />}
                    data={result.analysis.internal_linking}
                  />
                )}
                {result.analysis.crawl_depth && (
                  <AnalysisCard
                    title="Crawl Depth"
                    icon={<Layers className="w-5 h-5 text-teal-600" />}
                    data={result.analysis.crawl_depth}
                  />
                )}
                {result.analysis.duplicate_protection && (
                  <AnalysisCard
                    title="Duplicate Protection"
                    icon={<AlertTriangle className="w-5 h-5 text-cyan-600" />}
                    data={result.analysis.duplicate_protection}
                  />
                )}
              </div>
            )}

            <div className="bg-white rounded-2xl shadow-lg p-6">
              <h3 className="text-lg font-semibold text-slate-900 mb-4">Crawled Pages</h3>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {result.pages.map((page, index) => (
                  <div
                    key={index}
                    className={`p-4 rounded-lg border ${
                      page.status === 'success'
                        ? 'bg-green-50 border-green-200'
                        : 'bg-red-50 border-red-200'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-slate-900 break-all">{page.url}</p>
                        <p className="text-xs text-slate-600 mt-1">
                          Status: {page.status}
                          {page.depth !== undefined && <> &middot; Depth: {page.depth}</>}
                          {page.internal_links && <> &middot; Links: {page.internal_links.length}</>}
                        </p>
                      </div>
                      <span
                        className={`ml-4 px-2 py-1 text-xs rounded-full ${
                          page.status === 'success'
                            ? 'bg-green-100 text-green-700'
                            : 'bg-red-100 text-red-700'
                        }`}
                      >
                        {page.status === 'success' ? 'OK' : 'Error'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-slate-900 rounded-2xl shadow-lg p-6">
              <h3 className="text-lg font-semibold text-white mb-3">Complete JSON Output</h3>
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
