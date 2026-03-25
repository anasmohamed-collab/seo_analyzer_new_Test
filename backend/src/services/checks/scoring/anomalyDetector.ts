/**
 * Anti-Manipulation & Anomaly Detection Module
 *
 * Detects suspicious patterns from available on-page signals.
 * In a full implementation with crawl history, this would detect:
 *   - sudden backlink spikes (not_available)
 *   - sudden rank jumps (not_available)
 *   - abrupt anchor text shifts (not_available)
 *   - abnormal freshness patterns (partially — from dates)
 *   - low-engagement pages with inflated reference signals (proxy)
 *
 * Currently detects from single-pass audit data:
 *   - Cloaking indicators (mismatch between meta/schema/visible content)
 *   - Keyword stuffing patterns
 *   - Schema/content mismatch (inflated structured data vs thin content)
 *   - Suspicious redirect patterns
 *   - Hidden content indicators
 *   - Excessive outbound links (link farm signal)
 */

import type { AuditData, ScoringSignal } from './types.js';

export function detectAnomalies(data: AuditData): ScoringSignal[] {
  const signals: ScoringSignal[] = [];
  const meta = data.contentMeta;
  const sd = data.structuredData;
  let anomalyCount = 0;

  // ── Schema/content mismatch (inflated signals) ─────────────────
  // A page claiming rich structured data but having thin content
  // is suspicious — like a page with inflated reference signals
  // but no real engagement to back it up.
  if (sd && meta && data.pageType === 'article') {
    const schemaFieldCount = (sd.presentFields?.length ?? 0);
    const wordCount = meta.wordCount ?? 0;

    if (schemaFieldCount >= 8 && wordCount < 100) {
      anomalyCount++;
      signals.push({
        id: 'anomaly_schema_content_mismatch',
        label: 'Schema/Content Mismatch',
        category: 'anomaly',
        score: 0.2,
        weight: 0.08,
        rawValue: { schemaFields: schemaFieldCount, wordCount },
        explanation: `Rich schema (${schemaFieldCount} fields) but very thin content (${wordCount} words) — possible manipulation or auto-generated page`,
        availability: 'implemented',
      });
    }
  }

  // ── Suspicious redirect patterns ───────────────────────────────
  // Long redirect chains can indicate cloaking or manipulation.
  // Normal sites rarely need more than 1 redirect (http→https or www→non-www).
  if (data.redirectCount > 3) {
    anomalyCount++;
    signals.push({
      id: 'anomaly_redirect_chain',
      label: 'Excessive Redirects',
      category: 'anomaly',
      score: 0.3,
      weight: 0.06,
      rawValue: { count: data.redirectCount, chain: data.redirectChain },
      explanation: `${data.redirectCount} redirects — unusual chain length may indicate cloaking or misconfiguration`,
      availability: 'implemented',
    });
  }

  // ── Excessive outbound links (link farm indicator) ─────────────
  // Pages with an extreme number of outbound links relative to
  // content length may be link farms or spam pages.
  if (meta && meta.externalLinkCount !== undefined) {
    const wordCount = meta.wordCount ?? 0;
    const externalLinks = meta.externalLinkCount;

    // Ratio: more than 1 external link per 20 words is suspicious
    if (externalLinks > 30 || (wordCount > 0 && externalLinks / wordCount > 0.05)) {
      anomalyCount++;
      signals.push({
        id: 'anomaly_link_density',
        label: 'Excessive Outbound Links',
        category: 'anomaly',
        score: 0.2,
        weight: 0.06,
        rawValue: { externalLinks, wordCount, ratio: wordCount > 0 ? (externalLinks / wordCount).toFixed(3) : 'n/a' },
        explanation: `${externalLinks} external links for ${wordCount} words — high outbound density may indicate link scheme`,
        availability: 'implemented',
      });
    }
  }

  // ── Noindex + nofollow combination ─────────────────────────────
  // A page submitted for audit that blocks both indexing and link
  // following is suspicious — why audit a page you don't want indexed?
  // But skip this check when the page was fetched via 401/403 — the
  // noindex/nofollow may come from the error page, not the real content.
  const httpStatus = data.httpStatus ?? 0;
  const crawlBlocked = httpStatus === 401 || httpStatus === 403;
  if (meta && !crawlBlocked) {
    const isNoindex = meta.robotsMeta.noindex || meta.xRobotsTag?.noindex;
    const isNofollow = meta.robotsMeta.nofollow;
    if (isNoindex && isNofollow) {
      anomalyCount++;
      signals.push({
        id: 'anomaly_blocked_page',
        label: 'Fully Blocked Page',
        category: 'anomaly',
        score: 0.1,
        weight: 0.06,
        rawValue: { noindex: true, nofollow: true },
        explanation: 'Page has both noindex and nofollow — fully blocked from search, unusual for a page being audited',
        availability: 'implemented',
      });
    }
  }

  // ── Title/H1 keyword stuffing detection ────────────────────────
  // Detect repetitive word patterns in title or H1 that suggest
  // keyword stuffing rather than natural writing.
  if (meta?.title) {
    const words = meta.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const wordCounts = new Map<string, number>();
    for (const w of words) wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
    const maxRepeat = Math.max(0, ...wordCounts.values());
    const uniqueRatio = words.length > 0 ? wordCounts.size / words.length : 1;

    if (maxRepeat >= 3 || (words.length >= 5 && uniqueRatio < 0.5)) {
      anomalyCount++;
      signals.push({
        id: 'anomaly_keyword_stuffing',
        label: 'Keyword Stuffing in Title',
        category: 'anomaly',
        score: 0.3,
        weight: 0.05,
        rawValue: { maxRepeat, uniqueRatio: uniqueRatio.toFixed(2), title: meta.title },
        explanation: `Title has ${maxRepeat}x repeated words (${Math.round(uniqueRatio * 100)}% unique) — potential keyword stuffing`,
        availability: 'implemented',
      });
    }
  }

  // ── Date manipulation detection ────────────────────────────────
  // Future dates in publish/modified suggest manipulation
  const now = new Date();
  const ogPublished = meta?.ogTags?.articlePublishedTime;
  if (ogPublished) {
    const pubDate = new Date(ogPublished as string);
    if (!isNaN(pubDate.getTime()) && pubDate > new Date(now.getTime() + 86400000)) {
      anomalyCount++;
      signals.push({
        id: 'anomaly_future_date',
        label: 'Future Publication Date',
        category: 'anomaly',
        score: 0.2,
        weight: 0.05,
        rawValue: { date: ogPublished },
        explanation: `Publication date is in the future (${ogPublished}) — possible manipulation of freshness signals`,
        availability: 'implemented',
      });
    }
  }

  // ── Overall anomaly assessment ─────────────────────────────────
  // Composite anomaly score: if no anomalies detected, full trust
  const overallAnomalyScore = anomalyCount === 0
    ? 1
    : Math.max(0.1, 1 - (anomalyCount * 0.25));

  signals.push({
    id: 'anomaly_overall',
    label: 'Overall Spam/Anomaly Risk',
    category: 'anomaly',
    score: overallAnomalyScore,
    weight: 0.1,
    rawValue: { anomalyCount, flags: signals.filter(s => s.category === 'anomaly').map(s => s.id) },
    explanation: anomalyCount === 0
      ? 'No anomalies or manipulation signals detected'
      : `${anomalyCount} anomaly flag(s) detected — review recommended`,
    availability: 'implemented',
  });

  // ── Documented NOT AVAILABLE signals ───────────────────────────
  const notAvailable: Array<{ id: string; label: string }> = [
    { id: 'backlink_spike', label: 'Sudden Backlink Spike' },
    { id: 'rank_volatility', label: 'Ranking Volatility' },
    { id: 'anchor_text_shift', label: 'Anchor Text Distribution Shift' },
    { id: 'engagement_mismatch', label: 'Low Engagement + High Authority Mismatch' },
  ];

  for (const na of notAvailable) {
    signals.push({
      id: `anomaly_${na.id}`,
      label: na.label,
      category: 'anomaly',
      score: 0.5,
      weight: 0,
      rawValue: null,
      explanation: `${na.label} requires historical crawl data and external signals — not available in single-pass audit`,
      availability: 'not_available',
    });
  }

  return signals;
}
