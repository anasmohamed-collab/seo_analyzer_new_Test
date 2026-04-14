/**
 * HTML attribute parsing utilities shared by all SEO audit checks.
 *
 * ## Why this file exists
 *
 * Raw-HTML checks run in a plain Node.js process — no DOM, no browser.  Every
 * ad-hoc `html.match(/<tag[^>]*attr=["']value["']…/)` regex that gets written
 * directly inside a check function tends to:
 *   - break on valid but unquoted attribute values  (e.g. `rel=canonical`)
 *   - miss reversed attribute order                 (e.g. `href` before `rel`)
 *   - diverge from every other check's handling of the same edge cases
 *
 * This module is the single authoritative place for that logic.
 *
 * ## Adding a new extraction check
 *
 * Do NOT write a new `/<tag[^>]*attr=["']value["']/` regex inline.  Instead:
 *
 *   • For `<link>` attributes   → use `walkLinkTags(html, visitor)`
 *   • For `<meta>` attributes   → use `walkMetaTags(html, visitor)`
 *   • For any single attribute  → call `getAttrValue(attrString, name)`
 *
 * Both walkers pass the full attribute string of each matching tag to your
 * visitor callback so you can call `getAttrValue` on whatever attributes you
 * need.  The visitor can return `false` to stop iteration early.
 *
 * Example — extracting the first `<link rel="canonical">` href:
 *
 *   let canonical: string | null = null;
 *   walkLinkTags(html, (attrs) => {
 *     if (getAttrValue(attrs, 'rel')?.toLowerCase() === 'canonical') {
 *       canonical = getAttrValue(attrs, 'href');
 *       return false;
 *     }
 *   });
 *
 * ## Intentional non-uses
 *
 * `extractCharset()` in contentMetaCheck.ts is NOT ported here because its
 * legacy http-equiv form requires parsing a *nested* `charset=` token inside a
 * `content="text/html; charset=UTF-8"` attribute value — a fundamentally
 * different problem from simple attribute extraction.
 *
 * The two `og:type` / `article:published_time` regexes in
 * `detectPageTypeWithHtml()` in canonicalCheck.ts are page-classification
 * heuristics (not user-facing extraction).  They are candidates for migration
 * to `walkMetaTags` in a future pass but are intentionally left as-is to keep
 * that change scoped.
 *
 * ## Scope
 *
 * Keep this file minimal.  Add only when a new check's extraction needs are
 * not already covered by the existing exports.
 */

/**
 * Return the value of a named attribute from a tag's attribute string.
 *
 * Handles all three HTML5 quoting styles:
 *   name="value"   — double-quoted
 *   name='value'   — single-quoted
 *   name=value     — unquoted (valid for values that contain no whitespace,
 *                    `"`, `'`, `` ` ``, `=`, `<`, or `>`)
 *
 * Attribute name matching is case-insensitive, consistent with the HTML spec.
 *
 * @param attrs  The content of a tag between the tag name and the closing `>`,
 *               e.g. `' rel=canonical href="https://example.com/"'`.
 * @param name   Attribute name to look up (e.g. `'rel'`, `'href'`).
 * @returns      Trimmed attribute value, or `null` if the attribute is absent
 *               or has an empty value.
 */
export function getAttrValue(attrs: string, name: string): string | null {
  // Escape any regex metacharacters in the attribute name (defensive — real
  // HTML attribute names don't contain them, but this makes the helper safe
  // to call with arbitrary input).
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Three alternations:
  //   "([^"]*)"  — double-quoted value
  //   '([^']*)'  — single-quoted value
  //   ([^\s>"']+) — unquoted value (stops at whitespace, >, ", ')
  const re = new RegExp(
    `\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`,
    'i',
  );

  const m = attrs.match(re);
  if (!m) return null;
  const val = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  return val || null;
}

/**
 * Shared implementation for walking void HTML elements (tags with no closing
 * tag, e.g. <link>, <meta>).  Factored out so walkLinkTags and walkMetaTags
 * don't duplicate code.
 *
 * Handles self-closing (`<tag … />`) and regular (`<tag … >`) forms.
 * Attribute values should not contain a bare `>` in valid HTML (they use
 * `&gt;`), so the `[^>]` character class is safe for href/content values.
 */
function walkVoidTags(
  html: string,
  tagName: string,
  visitor: (attrs: string) => boolean | void,
): void {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${escaped}\\b([^>]*?)(?:\\/?>)`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (visitor(m[1]) === false) break;
  }
}

/**
 * Iterate every `<link>` tag in `html`, passing each tag's attribute string
 * to the `visitor` callback.  The visitor may return `false` to stop early
 * (useful when searching for the first match).
 */
export function walkLinkTags(
  html: string,
  visitor: (attrs: string) => boolean | void,
): void {
  walkVoidTags(html, 'link', visitor);
}

/**
 * Iterate every `<meta>` tag in `html`, passing each tag's attribute string
 * to the `visitor` callback.  The visitor may return `false` to stop early.
 *
 * Covers `<meta name="…" content="…">`, `<meta property="…" content="…">`,
 * and `<meta charset="…">` forms in any attribute order and quoting style.
 */
export function walkMetaTags(
  html: string,
  visitor: (attrs: string) => boolean | void,
): void {
  walkVoidTags(html, 'meta', visitor);
}

