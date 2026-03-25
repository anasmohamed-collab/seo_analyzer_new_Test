/**
 * Performance & CWV MVP — light timings + optional PageSpeed Insights.
 */
import process from 'node:process';

export interface PsiData {
  performance: number | null;
  lcp: number | null;
  cls: number | null;
  inp: number | null;
}

export interface PerformanceResult {
  mode: 'light' | 'psi';
  status: 'ok' | 'skipped' | 'error';
  ttfbMs: number | null;
  loadMs: number | null;
  htmlKb: number | null;
  psi: PsiData | null;
}

const PAGE_TIMEOUT = 15_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Light timing: fetch the URL, measure wall-clock time, compute HTML size.
 * Returns { html, perf } so the caller can reuse the HTML body.
 */
export async function runPerformanceCheck(
  url: string,
  prefetchedHtml?: string,
  prefetchedLoadMs?: number,
): Promise<PerformanceResult> {
  const result: PerformanceResult = {
    mode: 'light',
    status: 'ok',
    ttfbMs: null,
    loadMs: null,
    htmlKb: null,
    psi: null,
  };

  // ── Light timings (use prefetched if provided) ────────────────
  if (prefetchedHtml !== undefined) {
    result.loadMs = prefetchedLoadMs ?? null;
    result.htmlKb = Math.round((Buffer.byteLength(prefetchedHtml, 'utf8') / 1024) * 10) / 10;
  } else {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': UA, Accept: 'text/html' },
      });
      const body = await res.text();
      result.loadMs = Date.now() - start;
      result.htmlKb = Math.round((Buffer.byteLength(body, 'utf8') / 1024) * 10) / 10;
    } catch {
      result.status = 'error';
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Optional PSI ──────────────────────────────────────────────
  const apiKey = process.env['PAGESPEED_API_KEY'];
  if (!apiKey) {
    // stay mode=light, psi=null
    return result;
  }

  result.mode = 'psi';
  try {
    const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&key=${apiKey}&strategy=mobile&category=performance`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(psiUrl, { signal: controller.signal });
      if (!res.ok) {
        result.psi = null;
        result.status = 'error';
        return result;
      }
      const json = (await res.json()) as Record<string, unknown>;
      const lhr = json['lighthouseResult'] as Record<string, unknown> | undefined;
      const cats = lhr?.['categories'] as Record<string, unknown> | undefined;
      const perfCat = cats?.['performance'] as Record<string, unknown> | undefined;
      const audits = lhr?.['audits'] as Record<string, Record<string, unknown>> | undefined;

      result.psi = {
        performance: typeof perfCat?.['score'] === 'number' ? Math.round((perfCat['score'] as number) * 100) : null,
        lcp: typeof audits?.['largest-contentful-paint']?.['numericValue'] === 'number'
          ? Math.round(audits['largest-contentful-paint']['numericValue'] as number)
          : null,
        cls: typeof audits?.['cumulative-layout-shift']?.['numericValue'] === 'number'
          ? Math.round(((audits['cumulative-layout-shift']['numericValue'] as number) + Number.EPSILON) * 1000) / 1000
          : null,
        inp: typeof audits?.['interaction-to-next-paint']?.['numericValue'] === 'number'
          ? Math.round(audits['interaction-to-next-paint']['numericValue'] as number)
          : null,
      };
      result.status = 'ok';
    } finally {
      clearTimeout(timer);
    }
  } catch {
    result.status = 'error';
  }

  return result;
}
