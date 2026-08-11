/**
 * Build the POST /api/technical-analyzer/run request body for a project.
 *
 * Source 1: the project's stored last_form_values.
 * Source 2 (manual opt-in only): the previous COMPLETED audit's page types
 *           from GET /api/projects/:id/audits/latest — used only when an
 *           operator explicitly requests it for a single-project run.
 *
 * We never guess, generate, crawl, or derive a new article URL.
 */

const OPTIONAL_FORM_KEY_TO_API_KEY = {
  sectionUrl: 'section',
  tagUrl: 'tag',
  searchUrl: 'search',
  authorUrl: 'author',
  videoArticleUrl: 'video_article',
};

const OPTIONAL_PAGE_TYPES = ['section', 'tag', 'search', 'author', 'video_article'];

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseFormValues(project) {
  const fv = project?.last_form_values;
  if (fv == null) return null;
  if (typeof fv === 'object') return fv;
  if (typeof fv === 'string') {
    try {
      const parsed = JSON.parse(fv);
      return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** @returns {{ body, source: 'last_form_values' } | null} */
export function buildFromFormValues(project) {
  const fv = parseFormValues(project);
  if (!fv) return null;

  const homeUrl = cleanString(fv.homeUrl);
  const articleUrl = cleanString(fv.articleUrl);
  if (!homeUrl || !articleUrl) return null;

  const optionalUrls = {};
  for (const [formKey, apiKey] of Object.entries(OPTIONAL_FORM_KEY_TO_API_KEY)) {
    const value = cleanString(fv[formKey]);
    if (value) optionalUrls[apiKey] = value;
  }

  const body = { homeUrl, articleUrl };
  if (Object.keys(optionalUrls).length > 0) body.optionalUrls = optionalUrls;
  return { body, source: 'last_form_values' };
}

/**
 * @param latest response of GET /api/projects/:id/audits/latest
 * @returns {{ body, source: 'latest_audit' } | null}
 */
export function buildFromLatestAudit(latest) {
  const pages = latest?.results?.page_breakdown;
  if (!Array.isArray(pages)) return null;

  const urlByType = new Map();
  for (const page of pages) {
    const url = cleanString(page?.url);
    const type = cleanString(page?.page_type);
    if (url && type && !urlByType.has(type)) urlByType.set(type, url);
  }

  const homeUrl = urlByType.get('home');
  const articleUrl = urlByType.get('article');
  if (!homeUrl || !articleUrl) return null;

  const optionalUrls = {};
  for (const type of OPTIONAL_PAGE_TYPES) {
    const url = urlByType.get(type);
    if (url) optionalUrls[type] = url;
  }

  const body = { homeUrl, articleUrl };
  if (Object.keys(optionalUrls).length > 0) body.optionalUrls = optionalUrls;
  return { body, source: 'latest_audit' };
}

/**
 * @returns {Promise<{ok: true, body, source} | {ok: false, reason: 'SKIPPED_MISSING_AUDIT_CONFIG', detail: string}>}
 */
export async function buildRunRequest(
  project,
  apiClient,
  { signal, logger, allowHistoricalFallback = false } = {},
) {
  const fromForm = buildFromFormValues(project);
  if (fromForm) return { ok: true, ...fromForm };

  if (!allowHistoricalFallback) {
    return {
      ok: false,
      reason: 'SKIPPED_MISSING_AUDIT_CONFIG',
      detail: 'no usable stored homeUrl + articleUrl pair; historical audit fallback is disabled',
    };
  }

  let latest = null;
  try {
    latest = await apiClient.getLatestAudit(project.id, { signal });
  } catch (err) {
    logger?.debug?.(`Project ${project?.id}: latest-audit fallback unavailable: ${err.message}`);
  }

  const fromLatest = latest ? buildFromLatestAudit(latest) : null;
  if (fromLatest) return { ok: true, ...fromLatest };

  return {
    ok: false,
    reason: 'SKIPPED_MISSING_AUDIT_CONFIG',
    detail:
      'no usable homeUrl + articleUrl pair in last_form_values, and the latest completed audit ' +
      'does not clearly contain both a home and an article page for the explicit manual fallback',
  };
}
