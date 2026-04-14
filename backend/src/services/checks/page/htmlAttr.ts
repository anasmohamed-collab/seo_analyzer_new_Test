/**
 * Minimal HTML attribute parsing utilities.
 *
 * These helpers exist because raw-HTML SEO checks cannot rely on a full DOM
 * parser being available (the backend is Node.js without a browser environment).
 * They handle the three legal HTML5 attribute-value quoting styles so that
 * individual checks don't each re-invent fragile regex logic.
 *
 * Scope: intentionally minimal.  Only add to this file when a new check needs
 * attribute extraction that isn't already covered.
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

