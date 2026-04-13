/**
 * ProjectSelector
 *
 * A compact bar rendered above the SEOAgent analyzer form.
 * Only visible when the backend has DB mode available (checked via /api/health).
 *
 * Responsibilities:
 *  - List existing projects from GET /api/projects
 *  - Let the user select a project (pre-fills form values via onSelect callback)
 *  - Create a new project inline
 *  - Rename / delete the active project
 *
 * This component is purely additive — it does NOT import or touch any audit logic.
 */

import { useState, useEffect, useCallback } from 'react';
import { FolderOpen, Plus, Pencil, Trash2, Check, X, ChevronDown } from 'lucide-react';

export interface ProjectFormValues {
  homeUrl: string;
  articleUrl: string;
  sectionUrl?: string;
  tagUrl?: string;
  searchUrl?: string;
  authorUrl?: string;
  videoArticleUrl?: string;
}

export interface Project {
  id: string;
  domain: string;
  project_name: string | null;
  website_url: string | null;
  created_at: string;
  last_audit_at: string | null;
  audit_count: number;
  completed_count: number;
  last_form_values: ProjectFormValues | null;
}

interface ProjectSelectorProps {
  /** Called when a project is selected — parent should pre-fill the form */
  onSelect: (project: Project) => void;
  /** Called when no project is active (cleared) */
  onClear: () => void;
  /** Currently active project id (controlled) */
  activeProjectId: string | null;
  apiBase: string;
}

export default function ProjectSelector({
  onSelect,
  onClear,
  activeProjectId,
  apiBase,
}: ProjectSelectorProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  // Inline "new project" state
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [createError, setCreateError] = useState('');

  // Inline "rename" state
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  // Delete confirmation
  const [confirmDelete, setConfirmDelete] = useState(false);

  const activeProject = projects.find(p => p.id === activeProjectId) ?? null;

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/projects`);
      if (res.ok) {
        const data = await res.json() as { projects: Project[] };
        setProjects(data.projects ?? []);
      }
    } catch {
      // DB not available — stay hidden
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // ── Create project ──────────────────────────────────────────────

  const handleCreate = async () => {
    setCreateError('');
    if (!newUrl.trim()) { setCreateError('Website URL is required'); return; }
    try {
      const res = await fetch(`${apiBase}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_name: newName.trim() || undefined, website_url: newUrl.trim() }),
      });
      const data = await res.json() as { project?: Project; error?: string };
      if (!res.ok) { setCreateError(data.error ?? 'Failed to create project'); return; }
      await fetchProjects();
      setCreating(false);
      setNewName('');
      setNewUrl('');
      if (data.project) onSelect(data.project);
    } catch {
      setCreateError('Could not reach the server');
    }
  };

  // ── Rename project ──────────────────────────────────────────────

  const handleRename = async () => {
    if (!activeProject || !renameValue.trim()) return;
    try {
      const res = await fetch(`${apiBase}/api/projects/${activeProject.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_name: renameValue.trim() }),
      });
      if (res.ok) {
        await fetchProjects();
        setRenaming(false);
      }
    } catch { /* ignore */ }
  };

  // ── Delete project ──────────────────────────────────────────────

  const handleDelete = async () => {
    if (!activeProject) return;
    try {
      const res = await fetch(`${apiBase}/api/projects/${activeProject.id}`, { method: 'DELETE' });
      if (res.ok) {
        await fetchProjects();
        setConfirmDelete(false);
        onClear();
      }
    } catch { /* ignore */ }
  };

  // Don't render if DB is not available (no projects returned and not loading)
  if (!loading && projects.length === 0 && !creating) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-400 mb-4">
        <FolderOpen size={14} />
        <span>No projects yet.</span>
        <button
          onClick={() => setCreating(true)}
          className="text-blue-500 hover:underline"
        >
          Create your first project
        </button>
        {creating && renderCreateForm()}
      </div>
    );
  }

  function renderCreateForm() {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setCreating(false)}>
        <div className="bg-white rounded-lg shadow-xl p-5 w-80" onClick={e => e.stopPropagation()}>
          <h3 className="font-semibold text-slate-800 mb-3">New Project</h3>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-slate-500 block mb-1">Name (optional)</label>
              <input
                className="w-full border border-slate-200 rounded px-2 py-1.5 text-sm"
                placeholder="e.g. My News Site"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Website URL <span className="text-red-500">*</span></label>
              <input
                className="w-full border border-slate-200 rounded px-2 py-1.5 text-sm"
                placeholder="https://example.com"
                value={newUrl}
                onChange={e => setNewUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
              />
            </div>
            {createError && <p className="text-xs text-red-500">{createError}</p>}
            <div className="flex gap-2 pt-1">
              <button
                onClick={handleCreate}
                className="flex-1 bg-blue-600 text-white text-sm rounded px-3 py-1.5 hover:bg-blue-700"
              >
                Create
              </button>
              <button
                onClick={() => { setCreating(false); setCreateError(''); setNewName(''); setNewUrl(''); }}
                className="flex-1 border border-slate-200 text-slate-600 text-sm rounded px-3 py-1.5 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 mb-4 flex-wrap">
      <FolderOpen size={15} className="text-slate-400 flex-shrink-0" />
      <span className="text-xs text-slate-500 flex-shrink-0">Project:</span>

      {/* Project dropdown */}
      <div className="relative">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1.5 text-sm border border-slate-200 rounded-md px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-700 min-w-[160px]"
        >
          <span className="flex-1 text-left truncate max-w-[200px]">
            {activeProject
              ? (activeProject.project_name ?? activeProject.domain)
              : 'Select project…'}
          </span>
          <ChevronDown size={13} className="text-slate-400 flex-shrink-0" />
        </button>

        {open && (
          <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-30 min-w-[220px] py-1">
            {projects.map(p => (
              <button
                key={p.id}
                onClick={() => { onSelect(p); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center justify-between gap-2 ${
                  p.id === activeProjectId ? 'text-blue-600 bg-blue-50' : 'text-slate-700'
                }`}
              >
                <span className="truncate">{p.project_name ?? p.domain}</span>
                <span className="text-xs text-slate-400 flex-shrink-0">{p.completed_count} audits</span>
              </button>
            ))}
            <div className="border-t border-slate-100 mt-1 pt-1">
              <button
                onClick={() => { setOpen(false); onClear(); }}
                className="w-full text-left px-3 py-2 text-sm text-slate-500 hover:bg-slate-50"
              >
                Clear selection
              </button>
              <button
                onClick={() => { setOpen(false); setCreating(true); }}
                className="w-full text-left px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 flex items-center gap-1.5"
              >
                <Plus size={13} /> New project
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Actions for the active project */}
      {activeProject && !renaming && !confirmDelete && (
        <>
          <button
            onClick={() => { setRenaming(true); setRenameValue(activeProject.project_name ?? ''); }}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded"
            title="Rename project"
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            className="p-1.5 text-slate-400 hover:text-red-500 rounded"
            title="Delete project"
          >
            <Trash2 size={13} />
          </button>
          {activeProject.last_audit_at && (
            <span className="text-xs text-slate-400 ml-1">
              Last audit: {new Date(activeProject.last_audit_at).toLocaleDateString()}
            </span>
          )}
        </>
      )}

      {/* Inline rename */}
      {renaming && (
        <div className="flex items-center gap-1.5">
          <input
            className="border border-slate-200 rounded px-2 py-1 text-sm w-40"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenaming(false); }}
            autoFocus
          />
          <button onClick={handleRename} className="p-1 text-green-600 hover:text-green-700"><Check size={14} /></button>
          <button onClick={() => setRenaming(false)} className="p-1 text-slate-400 hover:text-slate-600"><X size={14} /></button>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-red-600 text-xs">Delete project and all its audits?</span>
          <button onClick={handleDelete} className="text-xs bg-red-600 text-white rounded px-2 py-1 hover:bg-red-700">Delete</button>
          <button onClick={() => setConfirmDelete(false)} className="text-xs border border-slate-200 rounded px-2 py-1 hover:bg-slate-50">Cancel</button>
        </div>
      )}

      {/* New project button (when no active project) */}
      {!activeProject && (
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 border border-blue-200 rounded-md px-2 py-1.5 hover:bg-blue-50"
        >
          <Plus size={12} /> New
        </button>
      )}

      {creating && renderCreateForm()}

      {/* Close dropdown on outside click */}
      {open && <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />}
    </div>
  );
}
