/**
 * ProjectsPage
 *
 * Renders at the "Projects" tab in App.tsx.
 * Lists all projects with basic stats and lets the user:
 *  - Open a project in the analyzer (switches back to the analyzer tab)
 *  - Delete a project
 *  - Create a new project
 *
 * This component makes no calls to any audit engine.
 * It only reads from and writes to /api/projects.
 */

import { useState, useEffect, useCallback } from 'react';
import { FolderOpen, Plus, Trash2, ExternalLink, Clock, BarChart2 } from 'lucide-react';
import type { Project } from './ProjectSelector';
import {
  describeCreateOutcome,
  describeCreateError,
  describeListError,
  type CreateOutcome,
} from './projectCreateMessages';

interface ProjectsPageProps {
  apiBase: string;
  /** Called when the user clicks "Open" on a project */
  onOpenProject: (project: Project) => void;
}

export default function ProjectsPage({ apiBase, onOpenProject }: ProjectsPageProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // New project form
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newHomeUrl, setNewHomeUrl] = useState('');
  const [newArticleUrl, setNewArticleUrl] = useState('');
  const [newIsBeta, setNewIsBeta] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createLoading, setCreateLoading] = useState(false);

  // Post-create feedback (created vs updated, automation readiness)
  const [notice, setNotice] = useState<CreateOutcome | null>(null);
  /** Highlighted row — the project that was just created or updated */
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // Delete confirmation
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${apiBase}/api/projects`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(describeListError(res.status, data.error));
        return;
      }
      const data = await res.json() as { projects: Project[] };
      setProjects(data.projects ?? []);
    } catch {
      setError('Could not reach the server. Make sure the backend is running.');
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  const handleCreate = async () => {
    setCreateError('');
    setNotice(null);
    if (!newUrl.trim()) { setCreateError('Website URL is required'); return; }
    setCreateLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_name: newName.trim() || undefined,
          website_url: newUrl.trim(),
          homeUrl: newHomeUrl.trim() || undefined,
          articleUrl: newArticleUrl.trim() || undefined,
          // Omit false so re-submitting an existing project cannot silently
          // overwrite its classification; new rows still default Production.
          is_beta: newIsBeta ? true : undefined,
        }),
      });

      let data: { project?: Project; created?: boolean; automation_ready?: boolean; error?: string };
      try {
        data = await res.json() as typeof data;
      } catch {
        // Never hide a backend failure behind a generic message.
        setCreateError(`Unexpected response from the server (HTTP ${res.status})`);
        return;
      }

      if (!res.ok) { setCreateError(describeCreateError(res.status, data.error)); return; }

      await fetchProjects();

      setNotice(describeCreateOutcome(data));
      setHighlightId(data.project?.id ?? null);

      setCreating(false);
      setNewName('');
      setNewUrl('');
      setNewHomeUrl('');
      setNewArticleUrl('');
      setNewIsBeta(false);
    } catch {
      setCreateError('Could not reach the server');
    } finally {
      setCreateLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeleteLoading(true);
    try {
      await fetch(`${apiBase}/api/projects/${id}`, { method: 'DELETE' });
      await fetchProjects();
      setDeleteId(null);
    } catch { /* ignore */ } finally {
      setDeleteLoading(false);
    }
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12 text-center text-slate-500 text-sm">
        Loading projects…
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12 text-center">
        <p className="text-red-500 text-sm mb-3">{error}</p>
        <p className="text-xs text-slate-400">Project management requires a database. Set DATABASE_URL to enable it.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold text-slate-800 flex items-center gap-2">
            <FolderOpen size={20} className="text-slate-500" />
            Projects
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Each project tracks audit history for one website.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 bg-blue-600 text-white text-sm rounded-lg px-4 py-2 hover:bg-blue-700"
        >
          <Plus size={14} /> New Project
        </button>
      </div>

      {/* New project form */}
      {creating && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-5">
          <h3 className="text-sm font-medium text-slate-700 mb-3">New Project</h3>
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="text-xs text-slate-500 block mb-1">Name (optional)</label>
              <input
                className="border border-slate-200 rounded px-2 py-1.5 text-sm w-44 bg-white"
                placeholder="My News Site"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Website URL <span className="text-red-500">*</span></label>
              <input
                className="border border-slate-200 rounded px-2 py-1.5 text-sm w-64 bg-white"
                placeholder="example.com"
                value={newUrl}
                onChange={e => setNewUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false); }}
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Homepage URL</label>
              <input
                className="border border-slate-200 rounded px-2 py-1.5 text-sm w-64 bg-white"
                placeholder="https://example.com/"
                value={newHomeUrl}
                onChange={e => setNewHomeUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false); }}
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Article URL</label>
              <input
                className="border border-slate-200 rounded px-2 py-1.5 text-sm w-64 bg-white"
                placeholder="https://example.com/an-article"
                value={newArticleUrl}
                onChange={e => setNewArticleUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false); }}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-600 pb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={newIsBeta}
                onChange={e => setNewIsBeta(e.target.checked)}
                className="rounded border-slate-300"
              />
              Beta / Staging site
            </label>
            <button
              onClick={handleCreate}
              disabled={createLoading}
              className="bg-blue-600 text-white text-sm rounded px-4 py-1.5 hover:bg-blue-700 disabled:opacity-50"
            >
              {createLoading ? 'Creating…' : 'Create'}
            </button>
            <button
              onClick={() => {
                setCreating(false); setCreateError('');
                setNewName(''); setNewUrl(''); setNewHomeUrl(''); setNewArticleUrl(''); setNewIsBeta(false);
              }}
              className="text-sm border border-slate-200 bg-white rounded px-3 py-1.5 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-2">
            Homepage and article URL are optional, but a project needs both before automated audits can run.
            They must belong to the same domain as the website URL.
          </p>
          {createError && <p className="text-xs text-red-500 mt-2">{createError}</p>}
        </div>
      )}

      {/* Post-create feedback */}
      {notice && (
        <div
          className={`rounded-lg px-4 py-2.5 mb-5 text-sm flex items-start justify-between gap-3 border ${
            notice.tone === 'success'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}
        >
          <span>{notice.text}</span>
          <button
            onClick={() => { setNotice(null); setHighlightId(null); }}
            className="text-xs underline opacity-70 hover:opacity-100 flex-shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Empty state */}
      {projects.length === 0 && (
        <div className="text-center py-16 text-slate-400">
          <FolderOpen size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No projects yet. Create one to start tracking audits.</p>
        </div>
      )}

      {/* Projects table */}
      {projects.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Project</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">Domain</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">
                  <span className="flex items-center gap-1"><Clock size={11} /> Last Audited</span>
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">
                  <span className="flex items-center gap-1"><BarChart2 size={11} /> Audits</span>
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {projects.map(p => (
                <tr
                  key={p.id}
                  className={p.id === highlightId ? 'bg-blue-50' : 'hover:bg-slate-50'}
                >
                  <td className="px-4 py-3 font-medium text-slate-700">
                    {p.project_name ?? p.domain}
                    {p.is_beta ? (
                      <span className="ml-2 text-[10px] font-normal text-violet-700 bg-violet-50 border border-violet-200 rounded px-1.5 py-0.5">
                        Beta
                      </span>
                    ) : null}
                    {!p.last_form_values?.homeUrl || !p.last_form_values?.articleUrl ? (
                      <span
                        className="ml-2 text-[10px] font-normal text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5"
                        title="Needs a homepage and article URL before automated audits can run"
                      >
                        no audit config
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs font-mono">
                    {p.domain}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">
                    {formatDate(p.last_audit_at)}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">
                    {p.completed_count} / {p.audit_count}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 justify-end">
                      {deleteId === p.id ? (
                        <>
                          <span className="text-xs text-red-600 mr-1">Delete all audits?</span>
                          <button
                            onClick={() => handleDelete(p.id)}
                            disabled={deleteLoading}
                            className="text-xs bg-red-600 text-white rounded px-2 py-1 hover:bg-red-700 disabled:opacity-50"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => setDeleteId(null)}
                            className="text-xs border border-slate-200 rounded px-2 py-1 hover:bg-slate-50"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => onOpenProject(p)}
                            className="flex items-center gap-1 text-xs text-blue-600 border border-blue-200 rounded px-3 py-1.5 hover:bg-blue-50"
                          >
                            <ExternalLink size={11} /> Open
                          </button>
                          <button
                            onClick={() => setDeleteId(p.id)}
                            className="p-1.5 text-slate-400 hover:text-red-500 rounded"
                            title="Delete project"
                          >
                            <Trash2 size={13} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
