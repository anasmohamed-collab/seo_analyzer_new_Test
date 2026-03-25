/**
 * Module 6 — Internal Linking Cluster Analyzer
 *
 * Analyzes internal link structure across crawled pages:
 *   - Link depth per page
 *   - Orphan article detection
 *   - Cluster structure strength
 *   - Links per article
 *   - Related articles block detection
 *   - Suggested internal links
 */

export function analyzeInternalLinking(crawledPages) {
  const result = {
    module: 'internal_linking',
    priority: 'high',
    status: 'PASS',
    score: 100,
    total_pages: crawledPages.length,
    total_internal_links: 0,
    avg_links_per_page: 0,
    orphan_urls: [],
    weak_pages: [],            // pages with very few incoming links
    deep_pages: [],            // pages at depth > 3
    cluster_analysis: {
      well_connected: 0,
      moderately_connected: 0,
      poorly_connected: 0,
    },
    has_related_articles: 0,
    suggested_links: [],
    issues: [],
  };

  if (crawledPages.length === 0) {
    result.status = 'FAIL';
    result.issues.push({ level: 'critical', message: 'No pages to analyze' });
    return result;
  }

  // Build link graph: page URL -> set of URLs it links to
  const outgoing = new Map();  // url -> [linked urls]
  const incoming = new Map();  // url -> [pages that link to it]
  const pageDepths = new Map(); // url -> depth
  const allUrls = new Set();

  for (const page of crawledPages) {
    if (!page.url || page.status !== 'success') continue;

    allUrls.add(page.url);
    pageDepths.set(page.url, page.depth || 0);

    const links = page.internal_links || [];
    outgoing.set(page.url, links);
    result.total_internal_links += links.length;

    for (const link of links) {
      if (!incoming.has(link)) incoming.set(link, []);
      incoming.get(link).push(page.url);
    }
  }

  // Average links per page
  result.avg_links_per_page = allUrls.size > 0
    ? Math.round(result.total_internal_links / allUrls.size * 10) / 10
    : 0;

  // Analyze each page
  for (const url of allUrls) {
    const inCount = incoming.has(url) ? incoming.get(url).length : 0;
    const outCount = outgoing.has(url) ? outgoing.get(url).length : 0;
    const depth = pageDepths.get(url) || 0;

    // Orphan detection (0 or 1 incoming links, not the start page)
    if (inCount <= 1 && depth > 0) {
      result.orphan_urls.push({ url, incoming_links: inCount, depth });
    }

    // Weak pages (few incoming)
    if (inCount < 3 && depth > 0) {
      result.weak_pages.push({ url, incoming_links: inCount, outgoing_links: outCount });
    }

    // Deep pages
    if (depth > 3) {
      result.deep_pages.push({ url, depth });
    }

    // Cluster classification
    if (inCount >= 5 && outCount >= 3) {
      result.cluster_analysis.well_connected++;
    } else if (inCount >= 2 && outCount >= 1) {
      result.cluster_analysis.moderately_connected++;
    } else {
      result.cluster_analysis.poorly_connected++;
    }
  }

  // Cap arrays to avoid bloated output
  result.orphan_urls = result.orphan_urls.slice(0, 50);
  result.weak_pages = result.weak_pages.slice(0, 50);
  result.deep_pages = result.deep_pages.slice(0, 50);

  // Generate suggested links: connect orphans to well-linked pages
  const wellLinked = [...allUrls]
    .filter(u => (incoming.get(u)?.length || 0) >= 5)
    .slice(0, 10);

  for (const orphan of result.orphan_urls.slice(0, 20)) {
    for (const target of wellLinked.slice(0, 3)) {
      const existingLinks = outgoing.get(orphan.url) || [];
      if (!existingLinks.includes(target) && orphan.url !== target) {
        result.suggested_links.push({
          from: orphan.url,
          to: target,
          reason: 'Orphan page should link to well-connected page',
        });
        break; // one suggestion per orphan
      }
    }
  }

  result.suggested_links = result.suggested_links.slice(0, 30);

  // Issues
  const orphanPct = allUrls.size > 0 ? (result.orphan_urls.length / allUrls.size) * 100 : 0;
  const deepPct = allUrls.size > 0 ? (result.deep_pages.length / allUrls.size) * 100 : 0;

  if (orphanPct > 30) {
    result.score -= 30;
    result.issues.push({
      level: 'critical',
      message: `${Math.round(orphanPct)}% of pages are orphans (0-1 incoming links). Add internal links.`,
    });
  } else if (orphanPct > 15) {
    result.score -= 15;
    result.issues.push({
      level: 'high',
      message: `${Math.round(orphanPct)}% of pages are orphans. Improve internal linking.`,
    });
  }

  if (deepPct > 20) {
    result.score -= 15;
    result.issues.push({
      level: 'high',
      message: `${Math.round(deepPct)}% of pages are deeper than 3 clicks from start. Flatten site structure.`,
    });
  }

  if (result.avg_links_per_page < 3) {
    result.score -= 10;
    result.issues.push({
      level: 'medium',
      message: `Average ${result.avg_links_per_page} internal links per page is too low. Aim for 5+.`,
    });
  }

  const poorlyConnectedPct = allUrls.size > 0
    ? (result.cluster_analysis.poorly_connected / allUrls.size) * 100
    : 0;

  if (poorlyConnectedPct > 40) {
    result.score -= 10;
    result.issues.push({
      level: 'medium',
      message: `${Math.round(poorlyConnectedPct)}% of pages are poorly connected. Create topic clusters.`,
    });
  }

  // Clamp
  result.score = Math.max(0, Math.min(100, result.score));

  if (result.score < 50) result.status = 'FAIL';
  else if (result.score < 80) result.status = 'WARNING';

  return result;
}
