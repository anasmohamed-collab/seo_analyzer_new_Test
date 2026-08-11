/**
 * robotsTxtAnalyzer.ts — Isolated robots.txt crawlability & sitemap-declaration auditor.
 *
 * Fully self-contained: does NOT import, call, or modify the existing audit
 * engine, scoring, page checks, or the News Sitemap module. It evaluates a
 * site's robots.txt for crawler access (with special attention to Googlebot and
 * Googlebot-News), sitemap declarations, and dangerous/invalid directives.
 *
 * On parsing: robots.txt is a line-oriented format, not XML — so "a proper
 * parser" here means a real grammar-aware, line-based parser that groups
 * user-agent records, understands Allow/Disallow/Sitemap/Crawl-delay, strips
 * comments, is case-insensitive on directive names, and evaluates path access
 * using Google's longest-match (Allow-wins-on-tie, * / $ wildcard) semantics.
 * This is deliberately NOT naive substring matching, and unlike a generic
 * allow/deny library it can also surface invalid directives such as `Noindex:`
 * that Google ignores in robots.txt.
 *
 * Pipeline: fetch → validate response → parse → evaluate Googlebot(-News) →
 * check sitemap declarations → score (0–100, with top-critical caps) → issues.
 */

import { isBotProtectionPage } from '../fetch/fetchEngine.js';
import { fetchWithSafeRedirects } from '../../../../shared/outbound-url-safety.js';
import type { OutboundHostResolver } from '../../../../shared/outbound-url-safety.js';

// ── Public types ──────────────────────────────────────────────────

export type IssueSeverity = 'critical' | 'warning' | 'info';
export type IssuePriority = 'top_critical' | 'normal';
export type CrawlStatus = 'Allowed' | 'Blocked' | 'Partially Blocked' | 'Unknown';

export interface RobotsTxtIssue {
  severity: IssueSeverity;
  priority: IssuePriority;
  type: string;
  message: string;
  matchedRule?: string;
  userAgent?: string;
  url?: string;
  field?: string;
  recommendation: string;
}

export type RobotsTxtStatus =
  | 'Excellent'
  | 'Good'
  | 'Needs Improvement'
  | 'Critical Issues';

export interface RobotsTxtScoreBreakdown {
  fetchability: number;          // out of 15
  validFormat: number;           // out of 15
  googlebotCrawlability: number; // out of 25
  googlebotNewsCrawlability: number; // out of 15
  sitemapDeclarations: number;   // out of 15
  noInvalidDirectives: number;   // out of 10
  cleanStructure: number;        // out of 5
}

export interface RobotsTxtAuditResult {
  analyzed: boolean;
  url: string;
  autoDetected: boolean;
  finalUrl: string;
  fetched: boolean;
  httpStatus: number;
  contentType: string;
  score: number;
  status: RobotsTxtStatus;
  scoreBreakdown: RobotsTxtScoreBreakdown;
  summary: {
    userAgentGroups: number;
    sitemapDirectives: number;
    xmlSitemapDeclared: boolean;
    newsSitemapDeclared: boolean;
    googlebotStatus: CrawlStatus;
    googlebotNewsStatus: CrawlStatus;
    invalidDirectives: number;
    criticalIssues: number;
    warnings: number;
  };
  sitemaps: string[];
  issues: RobotsTxtIssue[];
  recommendations: string[];
}

export interface AnalyzeRobotsTxtOptions {
  /** Explicit robots.txt URL. When omitted, derived from homeUrl + /robots.txt. */
  url?: string;
  /** Home URL — used for auto-detection and same-domain checks. */
  homeUrl?: string;
  /** Project's main XML Sitemap URL (to verify it is declared). */
  xmlSitemapUrl?: string;
  /** Project's Google News Sitemap URL (to verify it is declared). */
  newsSitemapUrl?: string;
  /** Important content URLs (article/section/tag/author/video) to test for blocking. */
  importantUrls?: string[];
  /** Restrict sitemap/host checks to this domain. Defaults to homeUrl's host. */
  expectedDomain?: string;
  /** Interpret crawler blocking as intentional for a Beta/Staging project. */
  isBeta?: boolean;
  /** Fetch timeout. Default 15 000 ms. */
  timeoutMs?: number;
  /** Max response bytes. Default 2 MB. */
  maxBytes?: number;
  /** Injected fetch (testability). */
  fetchFn?: typeof fetch;
  /** Injected A/AAAA resolver (testability). */
  resolver?: OutboundHostResolver;
}

// Outbound URL safety is enforced by the redirect-aware fetch helper below.

// ── Parsing model ─────────────────────────────────────────────────

interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
  raw: string;
  line: number;
}
interface RobotsGroup {
  userAgents: string[];
  rules: RobotsRule[];
  crawlDelay?: string;
}
interface SitemapDecl { url: string; line: number; }
interface DirectiveRecord { name: string; value: string; line: number; userAgents: string[]; }
interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: SitemapDecl[];
  unknownDirectives: DirectiveRecord[];
  noindexDirectives: DirectiveRecord[];
  invalidLines: number;
  nonBlankLines: number;
}

const KNOWN_FIELDS = new Set(['user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay', 'host', 'noindex']);

/**
 * Parse robots.txt into user-agent groups + global directives. Grammar-aware:
 * groups consecutive user-agent lines, strips comments, case-insensitive field
 * names, records unknown and invalid (`Noindex:`) directives. Pure; never throws.
 */
export function parseRobotsTxt(text: string): ParsedRobots {
  const lines = (text ?? '').split(/\r\n|\r|\n/);
  const groups: RobotsGroup[] = [];
  const sitemaps: SitemapDecl[] = [];
  const unknownDirectives: DirectiveRecord[] = [];
  const noindexDirectives: DirectiveRecord[] = [];
  let invalidLines = 0;
  let nonBlankLines = 0;

  let currentGroup: RobotsGroup | null = null;
  let expectingAgents = false; // true right after a user-agent line (still naming agents)

  lines.forEach((rawLine, idx) => {
    let line = idx === 0 ? rawLine.replace(/^﻿/, '') : rawLine;
    const hashIdx = line.indexOf('#');
    if (hashIdx !== -1) line = line.slice(0, hashIdx);
    line = line.trim();
    if (!line) return;
    nonBlankLines++;

    const colon = line.indexOf(':');
    if (colon === -1) { invalidLines++; return; }

    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const lineNo = idx + 1;

    switch (field) {
      case 'user-agent': {
        // A user-agent line after rules starts a NEW group.
        if (currentGroup && !expectingAgents) {
          groups.push(currentGroup);
          currentGroup = null;
        }
        if (!currentGroup) currentGroup = { userAgents: [], rules: [] };
        if (value) currentGroup.userAgents.push(value);
        expectingAgents = true;
        break;
      }
      case 'allow':
      case 'disallow': {
        if (!currentGroup) { invalidLines++; break; } // rule before any user-agent — ignored
        currentGroup.rules.push({
          type: field,
          path: value,
          raw: `${field === 'allow' ? 'Allow' : 'Disallow'}: ${value}`,
          line: lineNo,
        });
        expectingAgents = false;
        break;
      }
      case 'crawl-delay': {
        if (currentGroup) currentGroup.crawlDelay = value;
        expectingAgents = false;
        break;
      }
      case 'sitemap': {
        sitemaps.push({ url: value, line: lineNo });
        break; // non-group directive — does not affect grouping
      }
      case 'noindex': {
        noindexDirectives.push({
          name: 'noindex', value, line: lineNo,
          userAgents: currentGroup?.userAgents.slice() ?? ['*'],
        });
        expectingAgents = false;
        break;
      }
      case 'host': {
        unknownDirectives.push({ name: field, value, line: lineNo, userAgents: currentGroup?.userAgents.slice() ?? [] });
        break;
      }
      default: {
        if (!KNOWN_FIELDS.has(field)) {
          unknownDirectives.push({ name: field, value, line: lineNo, userAgents: currentGroup?.userAgents.slice() ?? [] });
        }
        expectingAgents = false;
      }
    }
  });
  if (currentGroup) groups.push(currentGroup);

  return { groups, sitemaps, unknownDirectives, noindexDirectives, invalidLines, nonBlankLines };
}

// ── Google path-matching semantics ────────────────────────────────

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  // Escape regex specials except '*', then expand '*' → '.*'.
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + (anchored ? '$' : ''));
}

/** Specificity = number of characters in the rule path (Google: longer wins). */
function isPathAllowed(rules: RobotsRule[], path: string): boolean {
  let bestSpec = -1;
  let decision: 'allow' | 'disallow' = 'allow';
  for (const rule of rules) {
    if (rule.path === '') continue; // empty Disallow/Allow = no restriction
    let matched = false;
    try { matched = patternToRegex(rule.path).test(path); } catch { matched = false; }
    if (!matched) continue;
    const spec = rule.path.length;
    if (spec > bestSpec) { bestSpec = spec; decision = rule.type; }
    else if (spec === bestSpec && rule.type === 'allow') { decision = 'allow'; } // Allow wins tie
  }
  return bestSpec === -1 ? true : decision === 'allow';
}

/** Merge rules across all groups whose user-agents match any of the given tokens. */
function mergedRulesFor(parsed: ParsedRobots, tokens: string[]): { rules: RobotsRule[]; matched: boolean; matchedAgent: string | null } {
  const lowered = tokens.map(t => t.toLowerCase());
  const rules: RobotsRule[] = [];
  let matched = false;
  let matchedAgent: string | null = null;
  for (const g of parsed.groups) {
    const uas = g.userAgents.map(u => u.toLowerCase());
    const hit = uas.find(u => lowered.includes(u));
    if (hit) { matched = true; matchedAgent = matchedAgent ?? hit; rules.push(...g.rules); }
  }
  return { rules, matched, matchedAgent };
}

/**
 * Resolve the rule set that applies to an agent, honouring Google's fallback:
 *   Googlebot-News → googlebot-news group → googlebot group → '*'
 *   Googlebot      → googlebot group → '*'
 */
function resolveAgent(parsed: ParsedRobots, agent: 'googlebot' | 'googlebot-news'): { rules: RobotsRule[]; via: string } {
  if (agent === 'googlebot-news') {
    const news = mergedRulesFor(parsed, ['googlebot-news']);
    if (news.matched) return { rules: news.rules, via: 'googlebot-news' };
    const bot = mergedRulesFor(parsed, ['googlebot']);
    if (bot.matched) return { rules: bot.rules, via: 'googlebot' };
  } else {
    const bot = mergedRulesFor(parsed, ['googlebot']);
    if (bot.matched) return { rules: bot.rules, via: 'googlebot' };
  }
  const star = mergedRulesFor(parsed, ['*']);
  return { rules: star.rules, via: star.matched ? '*' : 'none' };
}

const SAMPLE_PATHS = ['/', '/article/sample-news-story', '/section/politics', '/2026/06/18/sample-story', '/tag/elections'];

function crawlStatus(rules: RobotsRule[]): { status: CrawlStatus; fullyBlocked: boolean; blockingRule: RobotsRule | null } {
  const hasDisallow = rules.some(r => r.type === 'disallow' && r.path !== '');
  if (!hasDisallow) return { status: 'Allowed', fullyBlocked: false, blockingRule: null };
  const blockedAll = SAMPLE_PATHS.every(p => !isPathAllowed(rules, p));
  if (blockedAll) {
    const blockingRule = rules.find(r => r.type === 'disallow' && (r.path === '/' || r.path === '/*')) ?? null;
    return { status: 'Blocked', fullyBlocked: true, blockingRule };
  }
  return { status: 'Partially Blocked', fullyBlocked: false, blockingRule: null };
}

// ── URL helpers ───────────────────────────────────────────────────

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    return (u.origin + u.pathname).replace(/\/+$/, '').toLowerCase() + (u.search || '');
  } catch {
    return raw.trim().replace(/\/+$/, '').toLowerCase();
  }
}

function hostMatches(host: string, expectedDomain: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  let e = expectedDomain.toLowerCase().trim();
  try { if (/^https?:\/\//.test(e)) e = new URL(e).hostname; } catch { /* keep raw */ }
  e = e.replace(/^www\./, '');
  return h === e || h.endsWith(`.${e}`);
}

// ── Status bands ──────────────────────────────────────────────────

const STATUS_BANDS: Array<[number, RobotsTxtStatus]> = [
  [90, 'Excellent'], [75, 'Good'], [50, 'Needs Improvement'], [0, 'Critical Issues'],
];
function bandFor(score: number): RobotsTxtStatus {
  for (const [min, label] of STATUS_BANDS) if (score >= min) return label;
  return 'Critical Issues';
}

function emptyResult(url: string, autoDetected: boolean): RobotsTxtAuditResult {
  return {
    analyzed: false, url, autoDetected, finalUrl: url, fetched: false, httpStatus: 0, contentType: '',
    score: 0, status: 'Critical Issues',
    scoreBreakdown: {
      fetchability: 0, validFormat: 0, googlebotCrawlability: 0, googlebotNewsCrawlability: 0,
      sitemapDeclarations: 0, noInvalidDirectives: 0, cleanStructure: 0,
    },
    summary: {
      userAgentGroups: 0, sitemapDirectives: 0, xmlSitemapDeclared: false, newsSitemapDeclared: false,
      googlebotStatus: 'Unknown', googlebotNewsStatus: 'Unknown', invalidDirectives: 0,
      criticalIssues: 0, warnings: 0,
    },
    sitemaps: [], issues: [], recommendations: [],
  };
}

function finalize(result: RobotsTxtAuditResult): RobotsTxtAuditResult {
  result.summary.criticalIssues = result.issues.filter(i => i.severity === 'critical').length;
  result.summary.warnings = result.issues.filter(i => i.severity === 'warning').length;

  const b = result.scoreBreakdown;
  let score = Math.max(0, Math.min(100, Math.round(
    b.fetchability + b.validFormat + b.googlebotCrawlability + b.googlebotNewsCrawlability +
    b.sitemapDeclarations + b.noInvalidDirectives + b.cleanStructure,
  )));

  // Top-critical caps (apply the most restrictive that is triggered).
  const has = (t: string) => result.issues.some(i => i.type === t);
  let cap = 100;
  if (result.issues.some(i => i.priority === 'top_critical')) cap = Math.min(cap, 40);
  if (has('invalid_noindex_directive_in_robots_txt')) cap = Math.min(cap, 40);
  if (has('googlebot_news_fully_blocked')) cap = Math.min(cap, 30);
  if (has('googlebot_fully_blocked')) cap = Math.min(cap, 20);
  score = Math.min(score, cap);

  result.score = score;
  result.status = bandFor(score);
  result.recommendations = [...new Set(result.recommendations)];
  return result;
}

function addIssue(result: RobotsTxtAuditResult, issue: RobotsTxtIssue): void {
  result.issues.push(issue);
}

// ── Pure content analyzer (no network) — exported for tests ───────

export interface RobotsAnalyzeContext {
  url: string;
  autoDetected: boolean;
  finalUrl: string;
  httpStatus: number;
  contentType: string;
  options: AnalyzeRobotsTxtOptions;
}

export function analyzeRobotsTxtContent(text: string, ctx: RobotsAnalyzeContext): RobotsTxtAuditResult {
  const result = emptyResult(ctx.url, ctx.autoDetected);
  const isBeta = ctx.options.isBeta === true;
  result.analyzed = true;
  result.fetched = true;
  result.finalUrl = ctx.finalUrl;
  result.httpStatus = ctx.httpStatus;
  result.contentType = ctx.contentType;
  result.scoreBreakdown.fetchability = 15;

  const opts = ctx.options;
  const expectedDomain = opts.expectedDomain
    ?? (() => { try { return opts.homeUrl ? new URL(opts.homeUrl).hostname : undefined; } catch { return undefined; } })();

  const parsed = parseRobotsTxt(text);
  result.summary.userAgentGroups = parsed.groups.length;
  result.summary.invalidDirectives = parsed.noindexDirectives.length + parsed.unknownDirectives.filter(d => d.name !== 'host').length;

  // ── Valid format score ──
  const totalDirectiveLines = parsed.nonBlankLines;
  const formatRatio = totalDirectiveLines > 0 ? 1 - parsed.invalidLines / totalDirectiveLines : 1;
  result.scoreBreakdown.validFormat = Math.max(0, Math.round(15 * formatRatio));
  if (parsed.invalidLines > 0) {
    addIssue(result, {
      severity: 'warning', priority: 'normal', type: 'invalid_line_format',
      message: `${parsed.invalidLines} line(s) in robots.txt are not valid "directive: value" pairs and were ignored.`,
      recommendation: 'Fix malformed lines. Each directive must be written as "Field: value" (e.g. "Disallow: /private/").',
    });
  }
  if (parsed.groups.length === 0 && parsed.sitemaps.length === 0 && parsed.noindexDirectives.length === 0) {
    addIssue(result, {
      severity: 'info', priority: 'normal', type: 'empty_robots_txt',
      message: 'robots.txt is present but contains no user-agent groups or sitemap directives (effectively allows all crawling).',
      recommendation: 'Optionally declare your sitemaps and any intended crawl rules in robots.txt.',
    });
  }

  // ── Invalid Noindex directives (top critical) ──
  if (parsed.noindexDirectives.length > 0) {
    const underImportant = parsed.noindexDirectives.some(d =>
      d.userAgents.map(u => u.toLowerCase()).some(u => u === '*' || u === 'googlebot' || u === 'googlebot-news'));
    addIssue(result, {
      severity: 'critical', priority: 'top_critical', type: 'invalid_noindex_directive_in_robots_txt',
      message: 'A Noindex directive was found inside robots.txt. Google does not support Noindex in robots.txt.',
      matchedRule: `Noindex: ${parsed.noindexDirectives[0].value}`,
      userAgent: parsed.noindexDirectives[0].userAgents.join(', ') || undefined,
      recommendation: 'Remove the Noindex directive from robots.txt. If noindex is required, use a valid meta robots tag or X-Robots-Tag HTTP header instead.',
    });
    result.recommendations.push('Remove Noindex from robots.txt. Use meta robots noindex or X-Robots-Tag instead.');
    result.scoreBreakdown.noInvalidDirectives = 0;
    if (underImportant) {
      // Already top_critical; nothing further, but make sure it ranks first.
    }
  } else {
    // Deduct for other unknown (non-host) directives but don't zero out.
    const unknownNonHost = parsed.unknownDirectives.filter(d => d.name !== 'host').length;
    result.scoreBreakdown.noInvalidDirectives = Math.max(0, 10 - Math.min(10, unknownNonHost * 2));
    if (unknownNonHost > 0) {
      addIssue(result, {
        severity: 'info', priority: 'normal', type: 'unknown_directive',
        message: `robots.txt contains ${unknownNonHost} unrecognised directive(s) that crawlers may ignore.`,
        recommendation: 'Use only standard robots.txt directives (User-agent, Allow, Disallow, Sitemap, Crawl-delay).',
      });
    }
  }

  // ── Googlebot crawlability ──
  const gb = resolveAgent(parsed, 'googlebot');
  const gbStatus = crawlStatus(gb.rules);
  result.summary.googlebotStatus = gbStatus.status;
  if (gbStatus.fullyBlocked && !isBeta) {
    addIssue(result, {
      severity: 'critical', priority: 'top_critical', type: 'googlebot_fully_blocked',
      message: 'Googlebot is blocked from crawling the entire website.',
      matchedRule: gbStatus.blockingRule?.raw ?? 'Disallow: /',
      userAgent: gb.via === '*' ? '*' : 'Googlebot',
      recommendation: 'Remove or adjust the Disallow: / rule for Googlebot unless this is intentional. Blocking Googlebot can prevent pages from being crawled and indexed.',
    });
    result.recommendations.push('Review the Disallow: / rule blocking Googlebot — it can prevent Google from crawling and indexing the website.');
    result.scoreBreakdown.googlebotCrawlability = 0;
  } else if (gbStatus.fullyBlocked) {
    result.scoreBreakdown.googlebotCrawlability = 25;
  } else if (gbStatus.status === 'Partially Blocked') {
    result.scoreBreakdown.googlebotCrawlability = 18;
  } else {
    result.scoreBreakdown.googlebotCrawlability = 25;
  }

  // ── Googlebot-News crawlability (news-critical) ──
  const gbn = resolveAgent(parsed, 'googlebot-news');
  const gbnStatus = crawlStatus(gbn.rules);
  result.summary.googlebotNewsStatus = gbnStatus.status;
  if (gbnStatus.fullyBlocked && !isBeta) {
    addIssue(result, {
      severity: 'critical', priority: 'top_critical', type: 'googlebot_news_fully_blocked',
      message: 'Googlebot-News is blocked from crawling the website.',
      matchedRule: gbnStatus.blockingRule?.raw ?? 'Disallow: /',
      userAgent: gbn.via === '*' ? '*' : (gbn.via === 'googlebot' ? 'Googlebot' : 'Googlebot-News'),
      recommendation: 'Remove or adjust the Disallow rule for Googlebot-News. This can prevent news articles from being discovered for Google News.',
    });
    result.recommendations.push('Review the Disallow rule affecting Googlebot-News — it can prevent news articles from being discovered for Google News.');
    result.scoreBreakdown.googlebotNewsCrawlability = 0;
  } else if (gbnStatus.fullyBlocked) {
    result.scoreBreakdown.googlebotNewsCrawlability = 15;
  } else if (gbnStatus.status === 'Partially Blocked') {
    result.scoreBreakdown.googlebotNewsCrawlability = 10;
  } else {
    result.scoreBreakdown.googlebotNewsCrawlability = 15;
  }

  if (isBeta && (!gbStatus.fullyBlocked || !gbnStatus.fullyBlocked)) {
    const exposed = [
      !gbStatus.fullyBlocked ? 'Googlebot' : null,
      !gbnStatus.fullyBlocked ? 'Googlebot-News' : null,
    ].filter(Boolean).join(' and ');
    addIssue(result, {
      severity: 'warning', priority: 'normal', type: 'beta_search_crawlers_not_blocked',
      message: `Beta/Staging site is crawlable by ${exposed}.`,
      recommendation: 'Block search crawlers on the Beta/Staging environment until it is ready for Production.',
    });
    result.recommendations.push('Block Googlebot and Googlebot-News on the Beta/Staging environment until launch.');
  }

  // ── Important path blocking ──
  const importantUrls = (opts.importantUrls ?? []).filter(Boolean);
  for (const iu of importantUrls) {
    let path: string;
    try { path = new URL(iu).pathname; } catch { continue; }
    if (path === '/' || !path) continue;
    const blockedForGoogle = !isPathAllowed(gb.rules, path);
    if (blockedForGoogle && !isBeta) {
      addIssue(result, {
        severity: 'critical', priority: 'normal', type: 'important_news_path_blocked',
        message: 'An important content path appears to be blocked by robots.txt for Googlebot.',
        url: iu,
        userAgent: gb.via === '*' ? '*' : 'Googlebot',
        recommendation: 'Allow crawling of important news article/section URLs so Googlebot and Googlebot-News can discover and evaluate the content.',
      });
    }
  }

  // ── Sitemap declarations ──
  const sitemapUrls = parsed.sitemaps.map(s => s.url).filter(Boolean);
  result.sitemaps = sitemapUrls;
  result.summary.sitemapDirectives = parsed.sitemaps.length;

  // Validate each declared sitemap URL.
  const seenSitemaps = new Map<string, number>();
  for (const decl of parsed.sitemaps) {
    const raw = decl.url;
    if (!raw) {
      addIssue(result, { severity: 'warning', priority: 'normal', type: 'empty_sitemap_directive',
        message: 'An empty Sitemap directive was found in robots.txt.', matchedRule: 'Sitemap:',
        recommendation: 'Provide a full absolute URL after "Sitemap:".' });
      continue;
    }
    if (/\s/.test(raw)) {
      addIssue(result, { severity: 'warning', priority: 'normal', type: 'sitemap_url_contains_space',
        message: `A Sitemap URL contains whitespace: "${raw}".`, matchedRule: `Sitemap: ${raw}`,
        recommendation: 'Remove spaces from the Sitemap URL.' });
    }
    let su: URL | null = null;
    try { su = new URL(raw); } catch { su = null; }
    if (!su || (su.protocol !== 'http:' && su.protocol !== 'https:')) {
      addIssue(result, { severity: 'warning', priority: 'normal', type: 'invalid_sitemap_url',
        message: `A Sitemap directive is not a valid absolute http(s) URL: "${raw}".`, matchedRule: `Sitemap: ${raw}`,
        recommendation: 'Sitemap directives must use absolute URLs (https://example.com/sitemap.xml).' });
    } else {
      if (expectedDomain && !hostMatches(su.hostname, expectedDomain)) {
        addIssue(result, { severity: 'warning', priority: 'normal', type: 'sitemap_foreign_domain',
          message: `A declared Sitemap points to a different domain ("${su.hostname}").`, matchedRule: `Sitemap: ${raw}`,
          recommendation: 'Declare sitemaps hosted on the same domain as the site, unless cross-hosting is intentional and verified.' });
      }
      if (!/\.xml(\.gz)?($|[?#])/i.test(su.pathname) && !/sitemap/i.test(su.pathname)) {
        addIssue(result, { severity: 'info', priority: 'normal', type: 'sitemap_not_xml_like',
          message: `A declared Sitemap URL does not look like an XML sitemap: "${raw}".`, matchedRule: `Sitemap: ${raw}`,
          recommendation: 'Point Sitemap directives at .xml (or .xml.gz) sitemap files.' });
      }
      const key = normalizeUrl(raw);
      const n = (seenSitemaps.get(key) ?? 0) + 1;
      seenSitemaps.set(key, n);
      if (n === 2) {
        addIssue(result, { severity: 'warning', priority: 'normal', type: 'duplicate_sitemap_directive',
          message: `Duplicate Sitemap directive: "${raw}".`, matchedRule: `Sitemap: ${raw}`,
          recommendation: 'Remove duplicate Sitemap directives so each sitemap is declared once.' });
      }
    }
  }

  // Determine XML / News declaration (project values preferred, else heuristic).
  const normalizedDeclared = sitemapUrls.map(normalizeUrl);
  let xmlDeclared: boolean;
  let newsDeclared: boolean;
  if (opts.xmlSitemapUrl) {
    xmlDeclared = normalizedDeclared.includes(normalizeUrl(opts.xmlSitemapUrl));
  } else {
    xmlDeclared = sitemapUrls.some(s => /sitemap/i.test(s) && !/news/i.test(s));
  }
  if (opts.newsSitemapUrl) {
    newsDeclared = normalizedDeclared.includes(normalizeUrl(opts.newsSitemapUrl));
  } else {
    newsDeclared = sitemapUrls.some(s => /news/i.test(s));
  }
  result.summary.xmlSitemapDeclared = xmlDeclared;
  result.summary.newsSitemapDeclared = newsDeclared;

  // Sitemap-declaration score (two 7.5-point slots).
  let sitemapPoints = 0;
  if (xmlDeclared) sitemapPoints += 7.5;
  if (newsDeclared) sitemapPoints += 7.5;
  // If the project supplied no expected URLs and at least one sitemap is present,
  // give partial benefit of the doubt rather than zero.
  if (!opts.xmlSitemapUrl && !opts.newsSitemapUrl && sitemapUrls.length > 0) {
    sitemapPoints = Math.max(sitemapPoints, xmlDeclared || newsDeclared ? sitemapPoints : 7.5);
  }
  result.scoreBreakdown.sitemapDeclarations = Math.round(sitemapPoints);

  if (sitemapUrls.length === 0) {
    addIssue(result, {
      severity: 'warning', priority: 'normal', type: 'no_sitemap_in_robots_txt',
      message: 'robots.txt does not declare any Sitemap.',
      recommendation: 'Declare your sitemaps in robots.txt using one "Sitemap:" line per sitemap.',
    });
  }
  if (opts.xmlSitemapUrl && !xmlDeclared) {
    addIssue(result, {
      severity: 'warning', priority: 'normal', type: 'missing_xml_sitemap_in_robots_txt',
      message: 'The main XML Sitemap is not declared inside robots.txt.',
      field: 'Sitemap',
      recommendation: `Add the XML Sitemap URL to robots.txt using: Sitemap: ${opts.xmlSitemapUrl}`,
    });
    result.recommendations.push(`Add to robots.txt — Sitemap: ${opts.xmlSitemapUrl}`);
  }
  if (opts.newsSitemapUrl && !newsDeclared) {
    addIssue(result, {
      severity: 'warning', priority: 'normal', type: 'missing_news_sitemap_in_robots_txt',
      message: 'The Google News Sitemap is not declared inside robots.txt.',
      field: 'Sitemap',
      recommendation: `Add the News Sitemap URL to robots.txt using: Sitemap: ${opts.newsSitemapUrl}`,
    });
    result.recommendations.push(`Add to robots.txt — Sitemap: ${opts.newsSitemapUrl}`);
  }

  // ── Clean structure / consistency ──
  let clean = 5;
  const dupSitemaps = [...seenSitemaps.values()].filter(n => n > 1).length;
  if (dupSitemaps > 0) clean -= Math.min(2, dupSitemaps);
  // Duplicate user-agent groups (same single agent declared in multiple groups).
  const agentGroupCounts = new Map<string, number>();
  for (const g of parsed.groups) {
    for (const ua of g.userAgents) {
      const k = ua.toLowerCase();
      agentGroupCounts.set(k, (agentGroupCounts.get(k) ?? 0) + 1);
    }
  }
  const dupAgents = [...agentGroupCounts.entries()].filter(([, n]) => n > 1);
  if (dupAgents.length > 0) {
    clean -= 1;
    addIssue(result, {
      severity: 'info', priority: 'normal', type: 'duplicate_user_agent_group',
      message: `Multiple robots.txt groups target the same user-agent (${dupAgents.map(([a]) => a).slice(0, 3).join(', ')}).`,
      recommendation: 'Consolidate rules for each user-agent into a single group to avoid ambiguity.',
    });
  }
  result.scoreBreakdown.cleanStructure = Math.max(0, clean);

  buildRecommendations(result);
  return finalize(result);
}

function buildRecommendations(result: RobotsTxtAuditResult): void {
  if (result.summary.sitemapDirectives === 0 && result.recommendations.length === 0) {
    result.recommendations.push('Declare your XML and News sitemaps in robots.txt to aid crawler discovery.');
  }
  if (result.issues.length === 0) {
    result.recommendations.push('robots.txt looks healthy — keep sitemap declarations current.');
  }
}

// ── Async entry point (fetch + analyze, with auto-detection) ──────

interface RobotsFetch {
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  failureKind?: string;
  error?: string;
}

const FETCH_PROFILES = [
  { name: 'googlebot', ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
  { name: 'chrome', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
];

async function fetchRobotsTxt(url: string, opts: AnalyzeRobotsTxtOptions): Promise<RobotsFetch> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const fetchFn = opts.fetchFn ?? fetch;
  let last: RobotsFetch = { ok: false, status: 0, finalUrl: url, contentType: '', body: '', failureKind: 'timeout' };

  for (const profile of FETCH_PROFILES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const { response: res, finalUrl } = await fetchWithSafeRedirects(
        url,
        {
          signal: ctrl.signal,
          headers: { 'User-Agent': profile.ua, 'Accept': 'text/plain,*/*' },
        },
        { fetchFn, resolver: opts.resolver },
      );
      const ct = res.headers.get('content-type') ?? '';
      const raw = await res.text();
      const body = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;

      if (isBotProtectionPage(body)) {
        last = { ok: false, status: res.status, finalUrl, contentType: ct, body: '', failureKind: 'waf_challenge' };
        continue; // try next profile
      }
      if (res.ok) {
        return { ok: true, status: res.status, finalUrl, contentType: ct, body };
      }
      last = {
        ok: false, status: res.status, finalUrl, contentType: ct, body,
        failureKind: res.status === 404 || res.status === 410 ? 'not_found' : res.status >= 500 ? 'server_error' : 'access_denied',
      };
      // 404/5xx are definitive — no point retrying with another UA.
      if (res.status === 404 || res.status === 410 || res.status >= 500) break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      last = { ok: false, status: 0, finalUrl: url, contentType: '', body: '', failureKind: /abort|timeout/i.test(msg) ? 'timeout' : 'network_error', error: msg };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

export async function analyzeRobotsTxt(options: AnalyzeRobotsTxtOptions = {}): Promise<RobotsTxtAuditResult> {
  // Resolve target URL (explicit, else auto-detect from home URL).
  let url = (options.url ?? '').trim();
  let autoDetected = false;
  if (!url && options.homeUrl) {
    try { url = new URL('/robots.txt', options.homeUrl).href; autoDetected = true; } catch { url = ''; }
  }

  const result = emptyResult(url, autoDetected);
  if (!url) {
    result.issues.push({
      severity: 'critical', priority: 'top_critical', type: 'robots_txt_not_accessible',
      message: 'robots.txt could not be located: no valid Robots.txt URL was provided and it could not be derived from the Home URL.',
      recommendation: 'Provide a valid Robots.txt URL, or a Home URL so it can be auto-detected at /robots.txt.',
    });
    return finalize(result);
  }

  let fetched: RobotsFetch;
  try {
    fetched = await fetchRobotsTxt(url, options);
  } catch (e) {
    result.issues.push({
      severity: 'critical', priority: 'top_critical', type: 'robots_txt_not_accessible',
      message: `robots.txt could not be fetched successfully: ${e instanceof Error ? e.message : String(e)}.`,
      recommendation: 'Make sure robots.txt is accessible at the root of the domain and returns HTTP 200.',
    });
    return finalize(result);
  }

  result.finalUrl = fetched.finalUrl;
  result.httpStatus = fetched.status;
  result.contentType = fetched.contentType;

  if (!fetched.ok) {
    const reason = fetched.failureKind === 'waf_challenge' ? 'the request was blocked by a bot-protection/WAF challenge'
      : fetched.failureKind === 'not_found' ? `HTTP ${fetched.status} (not found)`
      : fetched.failureKind === 'timeout' ? 'the request timed out'
      : fetched.error ?? `HTTP ${fetched.status}`;
    result.issues.push({
      severity: 'critical', priority: 'top_critical', type: 'robots_txt_not_accessible',
      message: `robots.txt could not be fetched successfully (${reason}).`,
      recommendation: 'Make sure robots.txt is accessible at the root of the domain and returns HTTP 200.',
    });
    return finalize(result);
  }

  // HTML-instead-of-robots detection.
  const bodyHead = fetched.body.slice(0, 1000).toLowerCase();
  const looksHtml = /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/.test(bodyHead) || fetched.contentType.toLowerCase().includes('text/html');
  const looksRobots = /^\s*(user-agent|disallow|allow|sitemap|crawl-delay|#)/im.test(fetched.body);
  if (looksHtml && !looksRobots) {
    result.fetched = true;
    result.analyzed = true;
    result.scoreBreakdown.fetchability = 6;
    result.issues.push({
      severity: 'critical', priority: 'top_critical', type: 'robots_txt_not_accessible',
      message: 'The robots.txt URL returned HTML content instead of a plain-text robots.txt file.',
      recommendation: 'Serve robots.txt as plain text (text/plain) at the domain root. An HTML page here usually means the file is missing and a soft-404/landing page is returned.',
    });
    return finalize(result);
  }

  return analyzeRobotsTxtContent(fetched.body, {
    url,
    autoDetected,
    finalUrl: fetched.finalUrl,
    httpStatus: fetched.status,
    contentType: fetched.contentType,
    options,
  });
}
