/**
 * Module 4 — Mobile Speed & Core Web Vitals
 *
 * Analyzes page for Core Web Vitals (LCP, CLS, INP) by inspecting HTML:
 *   - Render-blocking resources
 *   - Large hero images without optimization
 *   - Unoptimized fonts
 *   - Script blocking estimation
 *   - Performance scoring: Good / Needs Improvement / Poor
 *   - Optional Lighthouse/PageSpeed API integration
 */
import process from 'node:process';

const PAGESPEED_API_KEY = process.env.PAGESPEED_API_KEY || '';
const PAGESPEED_TIMEOUT = 30000;

function analyzeRenderBlocking(html) {
  const blocking = [];

  // Synchronous stylesheets (no media=print, no preload)
  const styleLinks = html.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi);
  for (const m of styleLinks) {
    const tag = m[0];
    if (!tag.includes('media="print"') && !tag.includes("media='print'") && !tag.includes('as="style"')) {
      const hrefMatch = tag.match(/href=["']([^"']*?)["']/i);
      blocking.push({
        type: 'css',
        resource: hrefMatch ? hrefMatch[1] : 'unknown',
        suggestion: 'Consider async loading or critical CSS inlining',
      });
    }
  }

  // Synchronous scripts (no async, no defer, no type=module)
  const scripts = html.matchAll(/<script[^>]*src=["']([^"']*?)["'][^>]*>/gi);
  for (const m of scripts) {
    const tag = m[0];
    if (!tag.includes('async') && !tag.includes('defer') && !tag.includes('type="module"') && !tag.includes("type='module'")) {
      blocking.push({
        type: 'js',
        resource: m[1],
        suggestion: 'Add async or defer attribute',
      });
    }
  }

  return blocking;
}

function analyzeImages(html) {
  const issues = [];
  const images = html.matchAll(/<img[^>]*>/gi);
  let totalImages = 0;
  let withoutLazy = 0;
  let withoutDimensions = 0;
  let largeDataUrls = 0;
  let withoutWebp = 0;

  for (const m of images) {
    totalImages++;
    const tag = m[0];

    // Lazy loading
    if (!tag.includes('loading="lazy"') && !tag.includes("loading='lazy'") && !tag.includes('loading=lazy')) {
      withoutLazy++;
    }

    // Dimensions
    if (!tag.match(/width=["']?\d/i) || !tag.match(/height=["']?\d/i)) {
      withoutDimensions++;
    }

    // Check for large inline data URIs (causes large HTML)
    const srcMatch = tag.match(/src=["']([^"']*?)["']/i);
    if (srcMatch && srcMatch[1].startsWith('data:') && srcMatch[1].length > 5000) {
      largeDataUrls++;
    }

    // Check for modern formats
    const srcset = tag.match(/srcset=["']([^"']*?)["']/i);
    if (!srcset && srcMatch && !srcMatch[1].match(/\.(webp|avif)/i)) {
      withoutWebp++;
    }
  }

  if (withoutLazy > 3) {
    issues.push({
      level: 'high',
      message: `${withoutLazy} images without lazy loading. Add loading="lazy" to below-fold images.`,
    });
  }

  if (withoutDimensions > 3) {
    issues.push({
      level: 'medium',
      message: `${withoutDimensions} images missing explicit width/height. This causes CLS.`,
    });
  }

  if (largeDataUrls > 0) {
    issues.push({
      level: 'high',
      message: `${largeDataUrls} images use large inline data URIs. Serve as external files.`,
    });
  }

  if (withoutWebp > 5) {
    issues.push({
      level: 'medium',
      message: `${withoutWebp} images not using modern formats (WebP/AVIF). Consider conversion.`,
    });
  }

  return { totalImages, withoutLazy, withoutDimensions, largeDataUrls, issues };
}

function analyzeFonts(html) {
  const issues = [];
  const fontLinks = html.matchAll(/<link[^>]*href=["']([^"']*?fonts[^"']*?)["'][^>]*>/gi);
  let fontCount = 0;
  let withoutDisplay = 0;
  let withoutPreconnect = 0;

  const preconnects = html.matchAll(/<link[^>]*rel=["']preconnect["'][^>]*>/gi);
  const preconnectHosts = new Set();
  for (const p of preconnects) {
    const href = p[0].match(/href=["']([^"']*?)["']/i);
    if (href) preconnectHosts.add(href[1]);
  }

  for (const m of fontLinks) {
    fontCount++;
    // Check for font-display in the URL (Google Fonts)
    if (!m[1].includes('display=') && !m[0].includes('font-display')) {
      withoutDisplay++;
    }
    // Check preconnect
    try {
      const host = new URL(m[1]).origin;
      if (!preconnectHosts.has(host)) withoutPreconnect++;
    } catch { /* ignore */ }
  }

  // Also check inline @font-face
  const fontFaces = html.matchAll(/@font-face\s*\{[^}]*\}/gi);
  for (const f of fontFaces) {
    fontCount++;
    if (!f[0].includes('font-display')) withoutDisplay++;
  }

  if (withoutDisplay > 0) {
    issues.push({
      level: 'medium',
      message: `${withoutDisplay} font(s) without font-display property. Use font-display: swap to prevent FOIT.`,
    });
  }

  if (withoutPreconnect > 0) {
    issues.push({
      level: 'low',
      message: `${withoutPreconnect} external font(s) without preconnect hint. Add <link rel="preconnect">.`,
    });
  }

  return { fontCount, withoutDisplay, withoutPreconnect, issues };
}

function estimateLCP(html) {
  const htmlSize = html.length;
  const imageCount = (html.match(/<img/gi) || []).length;
  const heroImage = html.match(/<img[^>]*class=["'][^"']*hero[^"']*["']/i) ||
                    html.match(/<img[^>]*id=["'][^"']*hero[^"']*["']/i);
  const hasLazyHero = heroImage && heroImage[0].includes('loading="lazy"');

  let score = 'good';
  let estimateMs = 1500;

  if (htmlSize > 200000) { estimateMs += 500; }
  if (htmlSize > 500000) { estimateMs += 1000; score = 'needs_improvement'; }
  if (htmlSize > 1000000) { estimateMs += 2000; score = 'poor'; }
  if (imageCount > 30) { estimateMs += 500; }
  if (imageCount > 80) { estimateMs += 1000; score = 'poor'; }
  if (hasLazyHero) {
    estimateMs += 800;
    if (score === 'good') score = 'needs_improvement';
  }

  return { score, estimateMs, heroImageLazy: !!hasLazyHero };
}

function estimateCLS(html) {
  const images = html.matchAll(/<img[^>]*>/gi);
  let undimensioned = 0;
  for (const m of images) {
    if (!m[0].match(/width=["']?\d/i) || !m[0].match(/height=["']?\d/i)) undimensioned++;
  }

  const iframes = (html.match(/<iframe/gi) || []).length;
  const dynamicAds = html.includes('googletag') || html.includes('adsbygoogle') || html.includes('doubleclick');

  let score = 'good';
  let riskLevel = 0;

  if (undimensioned > 3) { riskLevel += 0.1; }
  if (undimensioned > 10) { riskLevel += 0.15; }
  if (iframes > 2) { riskLevel += 0.05; }
  if (dynamicAds) { riskLevel += 0.1; }

  if (riskLevel > 0.25) score = 'poor';
  else if (riskLevel > 0.1) score = 'needs_improvement';

  return { score, estimatedShift: Math.round(riskLevel * 100) / 100, undimensionedImages: undimensioned, dynamicAds };
}

function estimateINP(html) {
  const scriptCount = (html.match(/<script/gi) || []).length;
  const inlineScriptSize = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .reduce((sum, m) => sum + m[1].length, 0);
  const hasHeavyFrameworks = html.includes('react') || html.includes('angular') || html.includes('vue');

  let score = 'good';
  let estimateMs = 100;

  if (scriptCount > 15) estimateMs += 50;
  if (scriptCount > 30) { estimateMs += 100; score = 'needs_improvement'; }
  if (scriptCount > 50) { estimateMs += 200; score = 'poor'; }
  if (inlineScriptSize > 100000) { estimateMs += 100; if (score === 'good') score = 'needs_improvement'; }

  return { score, estimateMs, scriptCount, inlineScriptSize };
}

async function fetchPageSpeedData(url) {
  if (!PAGESPEED_API_KEY) return null;

  try {
    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&key=${PAGESPEED_API_KEY}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGESPEED_TIMEOUT);

    try {
      const res = await fetch(apiUrl, { signal: controller.signal });
      if (res.ok) {
        const data = await res.json();
        const metrics = data.lighthouseResult?.audits?.metrics?.details?.items?.[0];
        if (metrics) {
          return {
            lcp: metrics.largestContentfulPaint,
            cls: metrics.cumulativeLayoutShift,
            fid: metrics.firstInputDelay,
            tbt: metrics.totalBlockingTime,
            speed_index: metrics.speedIndex,
            performance_score: data.lighthouseResult?.categories?.performance?.score * 100,
          };
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch { /* ignore */ }

  return null;
}

export async function analyzeCoreWebVitals(html, pageUrl) {
  const result = {
    module: 'core_web_vitals',
    priority: 'high',
    status: 'PASS',
    score: 100,
    lcp: null,
    cls: null,
    inp: null,
    render_blocking: [],
    images: null,
    fonts: null,
    lighthouse: null,
    suggestions: [],
    issues: [],
  };

  // 1. LCP analysis
  result.lcp = estimateLCP(html);
  if (result.lcp.score === 'poor') {
    result.score -= 25;
    result.issues.push({ level: 'critical', message: 'LCP estimated as poor (>4s). Page is too large or images unoptimized.' });
  } else if (result.lcp.score === 'needs_improvement') {
    result.score -= 10;
    result.issues.push({ level: 'high', message: 'LCP needs improvement (2.5-4s). Optimize hero images and reduce HTML size.' });
  }
  if (result.lcp.heroImageLazy) {
    result.suggestions.push('Remove loading="lazy" from hero/above-fold image — it delays LCP.');
  }

  // 2. CLS analysis
  result.cls = estimateCLS(html);
  if (result.cls.score === 'poor') {
    result.score -= 25;
    result.issues.push({ level: 'critical', message: 'CLS risk is high. Many images without dimensions or dynamic ads.' });
  } else if (result.cls.score === 'needs_improvement') {
    result.score -= 10;
    result.issues.push({ level: 'high', message: 'CLS risk moderate. Add width/height to images and reserve ad space.' });
  }

  // 3. INP analysis
  result.inp = estimateINP(html);
  if (result.inp.score === 'poor') {
    result.score -= 20;
    result.issues.push({ level: 'critical', message: 'INP risk is high. Too many scripts on page.' });
  } else if (result.inp.score === 'needs_improvement') {
    result.score -= 10;
    result.issues.push({ level: 'high', message: 'INP risk moderate. Consider code splitting and lazy loading JS.' });
  }

  // 4. Render-blocking resources
  result.render_blocking = analyzeRenderBlocking(html);
  if (result.render_blocking.length > 5) {
    result.score -= 10;
    result.issues.push({ level: 'high', message: `${result.render_blocking.length} render-blocking resources found.` });
    result.suggestions.push('Inline critical CSS and defer non-critical stylesheets.');
    result.suggestions.push('Add async/defer to non-essential scripts.');
  } else if (result.render_blocking.length > 2) {
    result.score -= 5;
    result.issues.push({ level: 'medium', message: `${result.render_blocking.length} render-blocking resources found.` });
  }

  // 5. Image analysis
  result.images = analyzeImages(html);
  for (const issue of result.images.issues) {
    result.issues.push(issue);
    if (issue.level === 'high') result.score -= 5;
  }

  // 6. Font analysis
  result.fonts = analyzeFonts(html);
  for (const issue of result.fonts.issues) {
    result.issues.push(issue);
  }

  // 7. Lighthouse API (if key available)
  result.lighthouse = await fetchPageSpeedData(pageUrl);
  if (result.lighthouse) {
    result.suggestions.push('Lighthouse data available — see lighthouse field for precise metrics.');
  }

  // 8. General suggestions
  if (html.length > 200000) {
    result.suggestions.push('HTML size is large. Consider server-side compression (gzip/brotli).');
  }

  const viewport = html.match(/<meta[^>]*name=["']viewport["']/i);
  if (!viewport) {
    result.score -= 10;
    result.issues.push({ level: 'critical', message: 'No viewport meta tag. Page is not mobile-friendly.' });
    result.suggestions.push('Add <meta name="viewport" content="width=device-width, initial-scale=1">');
  }

  // Clamp score
  result.score = Math.max(0, Math.min(100, result.score));

  if (result.score < 50) result.status = 'FAIL';
  else if (result.score < 80) result.status = 'WARNING';
  else result.status = 'PASS';

  return result;
}
