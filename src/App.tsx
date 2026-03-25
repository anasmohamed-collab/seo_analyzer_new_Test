import SEOAgent from './components/SEOAgent';

function App() {
  return (
    <div>
      <div className="bg-white border-b border-slate-200 sticky top-0 z-50 shadow-sm">
        <div className="max-w-6xl mx-auto px-4">
          <div className="flex gap-1">
            <span className="px-6 py-4 font-medium text-sm text-blue-600 border-b-2 border-blue-600">
              Technical SEO Analyzer
            </span>
          </div>
        </div>
      </div>
      <SEOAgent />
    </div>
  );
}

export default App;
