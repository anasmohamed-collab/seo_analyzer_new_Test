/**
 * Validation for the POST /api/projects request body.
 *
 * Kept separate from the route so the rules are unit-testable without a database.
 * Nothing here touches the audit engine, the checklist, or scoring.
 */

import {
  normalizeProjectDomain,
  normalizeWebsiteUrl,
  parseWebUrl,
  describeUrlRejection,
} from './normalizeProjectDomain.js';

/**
 * Audit-configuration keys accepted on a project.
 * Mirrors the allowlist used by PATCH /api/projects/:id/form-values.
 */
export const FORM_VALUE_KEYS = [
  'homeUrl',
  'articleUrl',
  'sectionUrl',
  'tagUrl',
  'searchUrl',
  'authorUrl',
  'videoArticleUrl',
  'xmlSitemapUrl',
  'newsSitemapUrl',
  'robotsTxtUrl',
] as const;

export type FormValueKey = typeof FORM_VALUE_KEYS[number];

/** The pair the SEO audit runner requires before it will audit a project. */
export const REQUIRED_FORM_KEYS: FormValueKey[] = ['homeUrl', 'articleUrl'];

/** Keys that must resolve to the project's own normalized domain. */
const SAME_DOMAIN_KEYS: FormValueKey[] = ['homeUrl', 'articleUrl'];

export type FormValues = Partial<Record<FormValueKey, string>>;

export type ParsedCreateProject =
  | {
      ok: true;
      domain: string;
      websiteUrl: string;
      projectName: string;
      /** null means the caller omitted the classification */
      isBeta: boolean | null;
      /** null when the request supplied no audit configuration at all */
      formValues: FormValues | null;
    }
  | { ok: false; error: string };

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseOptionalBeta(input: Record<string, unknown>): boolean | null | undefined {
  const value = input.is_beta ?? input.isBeta;
  if (value === undefined) return null;
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * True when the stored configuration is complete enough for the standalone
 * runner to audit the project without falling back to a previous audit.
 * Matches ops/seo-audit-runner/src/buildRunRequest.js — both URLs required.
 */
export function isAutomationReady(storedFormValues: unknown): boolean {
  let fv = storedFormValues;
  if (typeof fv === 'string') {
    try {
      fv = JSON.parse(fv);
    } catch {
      return false;
    }
  }
  if (!fv || typeof fv !== 'object') return false;
  const record = fv as Record<string, unknown>;
  return REQUIRED_FORM_KEYS.every((key) => cleanString(record[key]) !== null);
}

/**
 * Collect audit URLs from either supported request shape. Top-level keys win
 * over the nested `last_form_values` object when both are present.
 */
function collectRawFormValues(body: Record<string, unknown>): Record<string, string> {
  const nested = body.last_form_values;
  const nestedRecord =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : {};

  const raw: Record<string, string> = {};
  for (const key of FORM_VALUE_KEYS) {
    const value = cleanString(body[key]) ?? cleanString(nestedRecord[key]);
    if (value) raw[key] = value;
  }
  return raw;
}

/**
 * Validate and normalize a create-project request.
 *
 * Audit configuration is all-or-nothing: supplying any audit URL requires both
 * homeUrl and articleUrl, because a half-configured project is silently skipped
 * by the runner. Supplying none is fine — the project is simply not yet
 * automation-ready.
 */
export function parseCreateProjectBody(body: unknown): ParsedCreateProject {
  const input =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  if (cleanString(input.website_url) === null) {
    return { ok: false, error: 'website_url is required' };
  }

  const isBeta = parseOptionalBeta(input);
  if (isBeta === undefined) {
    return { ok: false, error: 'is_beta must be a boolean when supplied' };
  }

  const site = normalizeWebsiteUrl(input.website_url);
  if (!site.ok) {
    return { ok: false, error: describeUrlRejection('website_url', site.reason) };
  }

  const raw = collectRawFormValues(input);
  const providedKeys = Object.keys(raw) as FormValueKey[];

  if (providedKeys.length === 0) {
    return {
      ok: true,
      domain: site.domain,
      websiteUrl: site.websiteUrl,
      projectName: cleanString(input.project_name) ?? site.domain,
      isBeta,
      formValues: null,
    };
  }

  const missing = REQUIRED_FORM_KEYS.filter((key) => !raw[key]);
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `Audit configuration is incomplete — ${missing.join(' and ')} ` +
        'must be supplied together with the other audit URLs',
    };
  }

  const formValues: FormValues = {};
  for (const key of providedKeys) {
    const parsed = parseWebUrl(raw[key]);
    if (!parsed.ok) {
      return { ok: false, error: describeUrlRejection(key, parsed.reason) };
    }

    if (SAME_DOMAIN_KEYS.includes(key)) {
      const keyDomain = normalizeProjectDomain(parsed.url.href);
      if (keyDomain !== site.domain) {
        return {
          ok: false,
          error: `${key} must belong to ${site.domain} (got ${keyDomain ?? 'an unusable domain'})`,
        };
      }
    }

    formValues[key] = raw[key];
  }

  return {
    ok: true,
    domain: site.domain,
    websiteUrl: site.websiteUrl,
    projectName: cleanString(input.project_name) ?? site.domain,
    isBeta,
    formValues,
  };
}
