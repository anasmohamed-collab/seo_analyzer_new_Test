function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isInterpretableRecommendations(value) {
  if (value == null || Array.isArray(value)) return true;
  if (typeof value !== 'string') return false;
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function submittedUrlList(submittedUrls) {
  if (Array.isArray(submittedUrls)) return submittedUrls;
  if (!submittedUrls || typeof submittedUrls !== 'object') return [];
  const urls = [submittedUrls.homeUrl, submittedUrls.articleUrl];
  if (submittedUrls.optionalUrls && typeof submittedUrls.optionalUrls === 'object') {
    urls.push(...Object.values(submittedUrls.optionalUrls));
  }
  return urls;
}

const TRUSTWORTHY_SITE_STATUSES = Object.freeze({
  robots: new Set(['FOUND', 'NOT_FOUND']),
  sitemap: new Set(['FOUND', 'NOT_FOUND', 'SOFT_404', 'INVALID_XML', 'INVALID_FORMAT']),
  newsSitemap: new Set(['FOUND', 'NOT_FOUND']),
});

function validateSiteChecks(value, reasons) {
  const checks = parseObject(value);
  if (!checks) {
    reasons.push('siteChecks are missing or uninterpretable');
    return;
  }
  for (const [key, statuses] of Object.entries(TRUSTWORTHY_SITE_STATUSES)) {
    const check = parseObject(checks[key]);
    const status = typeof check?.status === 'string' ? check.status : null;
    if (!status || !statuses.has(status)) {
      reasons.push(`siteChecks.${key} is missing, failed, blocked, or uninterpretable`);
    }
  }
}

/**
 * Conservative proof that a completed result is safe to use as a replacement
 * P0 snapshot. Every failure returns explicit operational reasons and leaves
 * lifecycle state untouched.
 */
export function evaluateAuditEvidence(
  payload,
  { expectedAuditRunId, expectedProjectId, submittedUrls } = {},
) {
  const reasons = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { complete: false, reasons: ['result payload is missing or malformed'] };
  }
  if (payload.error != null) reasons.push('result payload contains an API error');
  if (payload.status !== 'COMPLETED') reasons.push('audit status is not COMPLETED');

  if (expectedAuditRunId == null || payload.id == null) {
    reasons.push('audit identity is missing');
  } else if (String(payload.id) !== String(expectedAuditRunId)) {
    reasons.push('audit identity does not match the triggered run');
  }

  if (expectedProjectId == null || payload.siteId == null) {
    reasons.push('project/site identity is missing');
  } else if (String(payload.siteId) !== String(expectedProjectId)) {
    reasons.push('project/site identity does not match the selected project');
  }

  const normalizedExpected = submittedUrlList(submittedUrls).map(normalizeUrl);
  if (normalizedExpected.length < 2 || normalizedExpected.some((url) => !url)) {
    reasons.push('submitted URL evidence is missing or invalid');
  }
  const expectedSet = new Set(normalizedExpected.filter(Boolean));
  if (expectedSet.size !== normalizedExpected.filter(Boolean).length) {
    reasons.push('submitted URL evidence contains duplicates');
  }

  if (!Array.isArray(payload.results)) {
    reasons.push('page results collection is missing or malformed');
  } else {
    const seen = new Set();
    for (const [index, row] of payload.results.entries()) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        reasons.push(`page result ${index + 1} is malformed`);
        continue;
      }
      const resultUrl = normalizeUrl(row.url);
      if (!resultUrl) {
        reasons.push(`page result ${index + 1} has an invalid URL`);
      } else {
        if (!expectedSet.has(resultUrl)) reasons.push(`page result URL was not submitted: ${resultUrl}`);
        if (seen.has(resultUrl)) reasons.push(`page result URL is duplicated: ${resultUrl}`);
        seen.add(resultUrl);
      }

      const data = parseObject(row.data);
      if (!data) {
        reasons.push(`page result ${index + 1} data is missing or malformed`);
        continue;
      }
      const states = [row.page_state, data.page_state].filter((state) => state != null);
      if (states.length === 0 || states.some((state) => state !== 'OK')) {
        reasons.push(`page result ${index + 1} does not have trustworthy page_state=OK`);
      }
      const httpStatus = Number(data.httpStatus);
      if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300) {
        reasons.push(`page result ${index + 1} does not have a successful HTTP status`);
      }
      if (row.error || data.error) reasons.push(`page result ${index + 1} contains a fetch/audit error`);
      if (row.checksSkipped === true || data.checksSkipped === true) {
        reasons.push(`page result ${index + 1} skipped SEO checks`);
      }
      if (
        (Array.isArray(data.checkErrors) && data.checkErrors.length > 0) ||
        (data.checkErrors != null && !Array.isArray(data.checkErrors))
      ) {
        reasons.push(`page result ${index + 1} contains parsing/check errors`);
      }
      if (!isInterpretableRecommendations(row.recommendations)) {
        reasons.push(`page result ${index + 1} recommendations are uninterpretable`);
      }
    }

    for (const expectedUrl of expectedSet) {
      if (!seen.has(expectedUrl)) reasons.push(`submitted URL has no corresponding result: ${expectedUrl}`);
    }
  }

  if (!isInterpretableRecommendations(payload.siteRecommendations)) {
    reasons.push('siteRecommendations are uninterpretable');
  }
  validateSiteChecks(payload.siteChecks, reasons);

  return { complete: reasons.length === 0, reasons: [...new Set(reasons)] };
}
