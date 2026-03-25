// supabase/functions/v1/seo-site-crawler/index.ts
// Simple SEO crawler with safer fetch + proper errors

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

interface CrawlerPageResult {
  url: string;
  status: string;
  http_status?: number;
  internal_links?: string[];
  error?: string;
}

interface CrawlerResult {
  start_url: string;
  max_pages: number;
  total_pages_crawled: number;
  pages: CrawlerPageResult[];
}

const USER_AGENT =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse(
      {
        start_url: "",
        max_pages: 0,
        total_pages_crawled: 0,
        pages: [],
      },
      400,
      "Invalid JSON body"
    );
  }

  const startUrl = String(body.start_url || "").trim();
  let maxPages = Number(body.max_pages || 50);

  if (!startUrl) {
    return jsonResponse(
      {
        start_url: "",
        max_pages: 0,
        total_pages_crawled: 0,
        pages: [],
      },
      400,
      "start_url is required"
    );
  }

  if (isNaN(maxPages) || maxPages < 1) maxPages = 1;
  if (maxPages > 2000) maxPages = 2000;

  let origin: string;
  try {
    origin = new URL(startUrl).origin;
  } catch {
    return jsonResponse(
      {
        start_url: startUrl,
        max_pages: maxPages,
        total_pages_crawled: 0,
        pages: [],
      },
      400,
      "Invalid start_url"
    );
  }

  const visited = new Set<string>();
  const queue: string[] = [startUrl];
  const pages: CrawlerPageResult[] = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const currentUrl = queue.shift() as string;

    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    const pageResult: CrawlerPageResult = {
      url: currentUrl,
      status: "pending",
    };

    try {
      const res = await fetch(currentUrl, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      pageResult.http_status = res.status;

      // لو السيرفر راجع 4xx أو 5xx نخزن الخطأ ونكمّل
      if (!res.ok) {
        pageResult.status = "http_error";
        pageResult.error = `HTTP ${res.status}`;
        pages.push(pageResult);
        continue;
      }

      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) {
        pageResult.status = "skipped_non_html";
        pages.push(pageResult);
        continue;
      }

      const html = await res.text();
      pageResult.status = "success";

      // استخراج اللينكات الداخلية ببساطة (regex)
      const links = extractInternalLinks(html, currentUrl, origin);
      pageResult.internal_links = links;

      // نضيف اللينكات الجديدة للـ queue
      for (const link of links) {
        if (!visited.has(link)) {
          queue.push(link);
        }
      }
    } catch (err) {
      pageResult.status = "fetch_error";
      pageResult.error = (err as Error).message ?? "Unknown fetch error";
    }

    pages.push(pageResult);
  }

  const result: CrawlerResult = {
    start_url: startUrl,
    max_pages: maxPages,
    total_pages_crawled: pages.length,
    pages,
  };

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// استخراج اللينكات الداخلية من الـ HTML
function extractInternalLinks(
  html: string,
  baseUrl: string,
  origin: string
): string[] {
  const hrefRegex = /href=["']([^"'#]+)["']/gi;
  const links = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;

    try {
      const url = new URL(raw, baseUrl);
      if (url.origin === origin) {
        // نشيل الـ fragments والـ query لو حابب
        url.hash = "";
        const cleaned = url.href;
        links.add(cleaned);
      }
    } catch {
      // ignore invalid URLs
    }
  }

  return Array.from(links);
}

function jsonResponse(
  base: CrawlerResult,
  status: number,
  errorMessage: string
): Response {
  const payload = {
    ...base,
    error: errorMessage,
  };

  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
