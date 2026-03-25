/**
 * Module 5 — AMP Validator
 *
 * Detects and validates AMP pages:
 *   - rel=amphtml link detection
 *   - AMP canonical relationship validation
 *   - AMP HTML basic validation
 *   - Broken AMP page detection
 *   - Informational-only if AMP not found
 */

const FETCH_TIMEOUT = 10000;

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Analyzer/1.0)' },
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractAmpHtmlLink(html) {
  const m =
    html.match(/<link[^>]*rel=["']amphtml["'][^>]*href=["']([^"']*)["']/i) ||
    html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']amphtml["']/i);
  return m ? m[1].trim() : null;
}

function extractCanonical(html) {
  const m =
    html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i) ||
    html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);
  return m ? m[1].trim() : null;
}

function isAmpPage(html) {
  return /<html[^>]*(\s⚡|\samp)[\s>]/i.test(html);
}

function validateAmpHtml(html) {
  const issues = [];

  // Check for required AMP boilerplate
  if (!html.includes('<style amp-boilerplate>') && !html.includes('<style amp4email-boilerplate>')) {
    issues.push('Missing required AMP boilerplate style');
  }

  // Check for AMP runtime script
  if (!html.includes('cdn.ampproject.org/v0.js') && !html.includes('cdn.ampproject.org/amp4ads-v0.js')) {
    issues.push('Missing AMP runtime script (cdn.ampproject.org/v0.js)');
  }

  // Check for prohibited elements
  const prohibited = ['<img ', '<video ', '<audio ', '<iframe '];
  for (const tag of prohibited) {
    // In AMP, these should be amp-img, amp-video, etc.
    const regex = new RegExp(tag, 'gi');
    const matches = html.match(regex);
    if (matches && matches.length > 0) {
      const ampTag = tag.replace('<', '<amp-');
      issues.push(`Found ${matches.length} ${tag.trim()} tag(s) — use ${ampTag.trim()}> instead`);
    }
  }

  // Check for inline styles (not allowed except in <style amp-custom>)
  const inlineStyles = html.match(/\sstyle=["'][^"']+["']/gi);
  if (inlineStyles && inlineStyles.length > 0) {
    issues.push(`Found ${inlineStyles.length} inline style attribute(s) — AMP doesn't allow inline styles`);
  }

  // Check custom style size (max 75KB)
  const customStyleMatch = html.match(/<style amp-custom[^>]*>([\s\S]*?)<\/style>/i);
  if (customStyleMatch && customStyleMatch[1].length > 75000) {
    issues.push(`Custom style exceeds 75KB limit (${Math.round(customStyleMatch[1].length / 1000)}KB)`);
  }

  // Check for external stylesheets (not allowed except whitelisted)
  const extStyles = html.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']*)["'][^>]*>/gi);
  for (const m of extStyles) {
    if (!m[1].includes('fonts.googleapis.com') && !m[1].includes('cdn.ampproject.org')) {
      issues.push(`External stylesheet not allowed in AMP: ${m[1].substring(0, 100)}`);
    }
  }

  return issues;
}

export async function analyzeAmp(html, pageUrl) {
  const result = {
    module: 'amp_validator',
    priority: 'medium',
    status: 'PASS',
    amp_detected: false,
    amp_page_url: null,
    amp_relationship: {
      main_to_amp: null,     // rel=amphtml found?
      amp_to_main: null,     // AMP page canonical back to main?
      consistent: null,
    },
    validation: {
      is_valid_amp: null,
      issues: [],
    },
    issues: [],
  };

  // 1. Check if current page IS an AMP page
  const currentIsAmp = isAmpPage(html);

  // 2. Check for rel=amphtml link
  const ampHtmlUrl = extractAmpHtmlLink(html);

  if (!ampHtmlUrl && !currentIsAmp) {
    // No AMP at all - informational only
    result.status = 'PASS';
    result.issues.push({
      level: 'info',
      message: 'No AMP version detected. AMP is optional and not required for good SEO.',
    });
    return result;
  }

  result.amp_detected = true;

  if (currentIsAmp) {
    // Current page is AMP - validate it
    result.amp_page_url = pageUrl;
    const ampIssues = validateAmpHtml(html);
    result.validation.issues = ampIssues;
    result.validation.is_valid_amp = ampIssues.length === 0;

    // Check canonical on this AMP page
    const canonical = extractCanonical(html);
    result.amp_relationship.amp_to_main = canonical;

    if (!canonical) {
      result.issues.push({
        level: 'high',
        message: 'AMP page has no canonical URL. Add <link rel="canonical"> pointing to the main page.',
      });
    }

    if (ampIssues.length > 0) {
      result.status = 'WARNING';
      for (const issue of ampIssues.slice(0, 10)) {
        result.issues.push({ level: 'medium', message: issue });
      }
    }

    return result;
  }

  // 3. Current page links to AMP version
  result.amp_relationship.main_to_amp = ampHtmlUrl;
  result.amp_page_url = ampHtmlUrl;

  try {
    const ampRes = await fetchWithTimeout(ampHtmlUrl);

    if (!ampRes.ok) {
      result.status = 'FAIL';
      result.issues.push({
        level: 'critical',
        message: `AMP page returns HTTP ${ampRes.status}. Broken AMP link.`,
      });
      return result;
    }

    const ampHtml = await ampRes.text();

    // Validate AMP is actually an AMP page
    if (!isAmpPage(ampHtml)) {
      result.status = 'FAIL';
      result.issues.push({
        level: 'critical',
        message: 'Page linked as AMP is not a valid AMP page (missing ⚡ or amp attribute).',
      });
      return result;
    }

    // Validate AMP HTML
    const ampIssues = validateAmpHtml(ampHtml);
    result.validation.issues = ampIssues;
    result.validation.is_valid_amp = ampIssues.length === 0;

    // Check AMP canonical points back
    const ampCanonical = extractCanonical(ampHtml);
    result.amp_relationship.amp_to_main = ampCanonical;

    if (ampCanonical) {
      try {
        const normalizedCanonical = new URL(ampCanonical).href;
        const normalizedPage = new URL(pageUrl).href;
        result.amp_relationship.consistent = normalizedCanonical === normalizedPage;

        if (!result.amp_relationship.consistent) {
          result.status = 'FAIL';
          result.issues.push({
            level: 'critical',
            message: `AMP canonical (${ampCanonical}) doesn't match main page (${pageUrl}). This breaks AMP indexing.`,
          });
        }
      } catch {
        result.amp_relationship.consistent = false;
      }
    } else {
      result.status = 'WARNING';
      result.issues.push({
        level: 'high',
        message: 'AMP page has no canonical URL pointing back to main page.',
      });
    }

    // Report validation issues
    if (ampIssues.length > 0) {
      if (result.status === 'PASS') result.status = 'WARNING';
      for (const issue of ampIssues.slice(0, 10)) {
        result.issues.push({ level: 'medium', message: `AMP validation: ${issue}` });
      }
    }
  } catch (err) {
    result.status = 'WARNING';
    result.issues.push({
      level: 'high',
      message: `Failed to fetch AMP page: ${err.message}`,
    });
  }

  return result;
}
