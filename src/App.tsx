import { useState, useCallback } from 'react';
import SEOAgent from './components/SEOAgent';
import ProjectSelector from './components/ProjectSelector';
import ProjectsPage from './components/ProjectsPage';
import AuditHistoryPanel from './components/AuditHistoryPanel';
import type { Project, ProjectFormValues } from './components/ProjectSelector';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

type AppView = 'analyzer' | 'projects';

// Must match the AuditRunData interface in SEOAgent.tsx
interface AuditRunData {
  id: string;
  status: string;
  siteChecks: Record<string, unknown> | null;
  siteRecommendations: unknown[];
  resultsByType: Record<string, unknown[]>;
  results: unknown[];
}

export default function App() {
  const [view, setView] = useState<AppView>('analyzer');
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [formValues, setFormValues] = useState<ProjectFormValues | null>(null);
  const [loadedAudit, setLoadedAudit] = useState<AuditRunData | null>(null);

  // ── Project selection ───────────────────────────────────────────

  const handleSelectProject = useCallback((project: Project) => {
    setActiveProject(project);
    setFormValues(project.last_form_values ?? null);
    setLoadedAudit(null);
    setView('analyzer');
  }, []);

  const handleClearProject = useCallback(() => {
    setActiveProject(null);
    setFormValues(null);
    setLoadedAudit(null);
  }, []);

  // ── After an audit starts (DB mode): save form values to project ─

  const handleAuditStarted = useCallback((siteId: string, values: ProjectFormValues) => {
    // Update active project id to match the newly created/upserted site
    setActiveProject(prev => prev ? { ...prev, id: siteId } : null);
    // Fire-and-forget — non-critical metadata save
    fetch(`${API_BASE}/api/projects/${siteId}/form-values`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    }).catch(() => { /* ignore */ });
  }, []);

  // ── Loading a past audit from history ──────────────────────────

  const handleLoadAudit = useCallback((data: AuditRunData) => {
    setLoadedAudit(data);
  }, []);

  return (
    <div>
      {/* ── Top navigation bar ───────────────────────────────────── */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-50 shadow-sm">
        <div className="max-w-6xl mx-auto px-4">
          <div className="flex gap-1">
            <button
              onClick={() => setView('analyzer')}
              className={`px-6 py-4 font-medium text-sm border-b-2 transition-colors ${
                view === 'analyzer'
                  ? 'text-blue-600 border-blue-600'
                  : 'text-slate-500 border-transparent hover:text-slate-700'
              }`}
            >
              Technical SEO Analyzer
            </button>
            <button
              onClick={() => setView('projects')}
              className={`px-6 py-4 font-medium text-sm border-b-2 transition-colors ${
                view === 'projects'
                  ? 'text-blue-600 border-blue-600'
                  : 'text-slate-500 border-transparent hover:text-slate-700'
              }`}
            >
              Projects
            </button>
          </div>
        </div>
      </div>

      {/* ── Projects view ─────────────────────────────────────────── */}
      {view === 'projects' && (
        <ProjectsPage
          apiBase={API_BASE}
          onOpenProject={handleSelectProject}
        />
      )}

      {/* ── Analyzer view ─────────────────────────────────────────── */}
      {view === 'analyzer' && (
        <>
          {/* Project selector + history panel — above the analyzer form */}
          <div className="max-w-6xl mx-auto px-4 pt-4">
            <ProjectSelector
              apiBase={API_BASE}
              activeProjectId={activeProject?.id ?? null}
              onSelect={handleSelectProject}
              onClear={handleClearProject}
            />

            {activeProject && (
              <AuditHistoryPanel
                projectId={activeProject.id}
                projectName={activeProject.project_name ?? activeProject.domain}
                apiBase={API_BASE}
                onLoadAudit={handleLoadAudit}
              />
            )}
          </div>

          {/* Existing SEOAgent — receives optional project props only.
              key= forces a clean remount when the active project changes
              so initialFormValues and initialRunData are applied fresh. */}
          <SEOAgent
            key={activeProject?.id ?? 'no-project'}
            initialFormValues={formValues ?? undefined}
            initialRunData={loadedAudit ?? undefined}
            onAuditStarted={handleAuditStarted}
          />
        </>
      )}
    </div>
  );
}
