import { normalizeDomainKey } from './normalizeDomain.js';

/**
 * Exact hostname LABELS that mark a non-production environment. Matching is
 * label-exact (`hostname.split('.')`), never substring — `newtimes.co.rw` and
 * `stagecoach.example.com` are Production sites and must stay eligible.
 *
 * Kept in sync with the GSC sync and audit-config discovery classifiers, which
 * already recognize the exact label `new` (as in `new.example.com`).
 */
export const NONPRODUCTION_LABELS = new Set([
  'beta',
  'new',
  'next',
  'staging',
  'stage',
  'dev',
  'development',
  'test',
  'testing',
  'preview',
  'demo',
  'sandbox',
  'qa',
  'uat',
]);

function asIdSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map(String));
  return new Set();
}

function parseFormValues(project) {
  const value = project?.last_form_values;
  if (value == null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeStoredWebUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return normalizeDomainKey(url.href);
  } catch {
    return null;
  }
}

function hasNonproductionLabel(domainKey) {
  const hostname = String(domainKey).replace(/:\d+$/, '');
  return hostname.split('.').some((label) => NONPRODUCTION_LABELS.has(label));
}

function result(eligible, reason, source = null) {
  return { eligible, reason, source };
}

/**
 * Evaluate whether a discovered project is safe for an automated audit.
 * This function is pure so list/dry-run/live selection share one policy.
 */
export function evaluateProjectEligibility(
  project,
  config = {},
  { allowHistoricalFallback = false } = {},
) {
  const id = project?.id == null ? '' : String(project.id);
  if (!id) return result(false, 'project has no ID');

  const includeIds = asIdSet(config.includeProjectIds);
  const excludeIds = asIdSet(config.excludeProjectIds);
  if (excludeIds.has(id)) return result(false, 'project ID is explicitly excluded');
  if (includeIds.size > 0 && !includeIds.has(id)) {
    return result(false, 'project ID is not in RUNNER_INCLUDE_PROJECT_IDS');
  }

  const projectDomain = normalizeDomainKey(project?.domain ?? project?.website_url);
  if (!projectDomain) return result(false, 'project domain is missing or invalid');
  // An explicit persisted Beta classification is authoritative. Beta projects
  // still run scheduled audits; their notification suppression happens later
  // in the alert pipeline. The domain-name heuristic remains for unclassified
  // legacy projects.
  if (
    config.excludeNonproduction !== false &&
    project?.is_beta !== true &&
    hasNonproductionLabel(projectDomain)
  ) {
    return result(false, 'domain contains a non-production environment label');
  }

  const formValues = parseFormValues(project);
  const homeUrl = cleanString(formValues?.homeUrl);
  const articleUrl = cleanString(formValues?.articleUrl);
  if (!homeUrl || !articleUrl) {
    if (allowHistoricalFallback) {
      return result(true, 'eligible for explicit manual historical fallback', 'latest_audit');
    }
    return result(false, 'stored homeUrl + articleUrl configuration is missing');
  }

  const homeDomain = normalizeStoredWebUrl(homeUrl);
  const articleDomain = normalizeStoredWebUrl(articleUrl);
  if (!homeDomain || !articleDomain) {
    return result(false, 'stored homeUrl or articleUrl is not a valid http(s) URL');
  }
  if (homeDomain !== projectDomain || articleDomain !== projectDomain) {
    return result(false, 'stored homeUrl/articleUrl does not match the project domain');
  }

  return result(true, 'stored configuration matches project domain', 'last_form_values');
}
