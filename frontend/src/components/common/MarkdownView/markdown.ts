/**
 * Safe Markdown → HTML rendering for the hint panel (and any UI text that may
 * be authored by the deployment owner via custom assets).
 *
 * Security model (no third-party sanitizer needed):
 *  - raw HTML tokens are ESCAPED, never emitted (marked would pass them
 *    through verbatim by default);
 *  - link/image hrefs are validated: only `http:`, `https:`, `mailto:` and
 *    scheme-less (relative/anchor) URLs pass; `javascript:`, `data:`, `vbscript:`
 *    etc. are dropped;
 *  - images are neutralized to their escaped alt text (no `<img>` loading);
 *  - links get `target="_blank" rel="noopener noreferrer"`.
 */
import { marked, type Parser, type Renderer, type RendererObject, type Tokens } from 'marked'

/** Relative links are resolved against an inert HTTPS base before validation. */
const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:']

/** HTML-escapes a string for safe text/attribute output. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** True when a URL may be used as a link target in rendered Markdown. */
export function isSafeUrl(url: string): boolean {
  // Browsers strip embedded tabs and newlines before interpreting a scheme.
  if (/[\u0000-\u001f\u007f]/.test(url)) return false
  const trimmed = url.trim()
  if (!trimmed) return false
  try {
    return SAFE_PROTOCOLS.includes(new URL(trimmed, 'https://markdown.invalid/').protocol)
  } catch {
    return false
  }
}

/** Renders link/image inline tokens to HTML via the active parser. */
function parseInlineTokens(parser: Parser<string, string>, tokens: unknown[], fallback: string): string {
  if (tokens.length > 0) return parser.parseInline(tokens as Tokens.Generic[])
  return fallback
}

// Renderer overrides: operate on top of the default renderer so everything
// else (headings, lists, code blocks, tables, …) keeps the stock behavior.
const safeRenderer: RendererObject = {
  html({ text }: Tokens.HTML | Tokens.Tag) {
    // Never emit raw HTML authored in a hint file (XSS guard).
    return escapeHtml(text)
  },
  link(this: Renderer, { href, title, text, tokens }: Tokens.Link) {
    const label = parseInlineTokens(this.parser, tokens ?? [], text)
    if (!isSafeUrl(href)) return label
    const safeHref = escapeHtml(href)
    const safeTitle = title ? ` title="${escapeHtml(title)}"` : ''
    return `<a href="${safeHref}"${safeTitle} target="_blank" rel="noopener noreferrer">${label}</a>`
  },
  image(this: Renderer, { href, title, text, tokens }: Tokens.Image) {
    // No remote images in hints: show the escaped alt text (plus the title
    // when present) instead of rendering an <img>.
    const alt = parseInlineTokens(this.parser, tokens ?? [], text).trim()
    const label = [alt, title].filter(Boolean).join(' — ')
    void href // href is intentionally unused (images are never rendered)
    return `[${escapeHtml(label)}]`
  },
}

// Apply the safe renderer to the shared marked instance once: everything this
// module renders (hint pages) goes through the same sanitizing pipeline.
marked.use({ renderer: safeRenderer })

export interface RenderMarkdownOptions {
  /** GitHub-flavored Markdown (tables, strikethrough). Default true. */
  gfm?: boolean
}

const DEFAULTS: RenderMarkdownOptions = { gfm: true }

/** Renders Markdown to sanitized HTML (see the module header for the safety model). */
export function renderMarkdown(source: string, opts: RenderMarkdownOptions = DEFAULTS): string {
  // `async: false` pins the sync overload — the return type is a plain string.
  return marked.parse(source, { gfm: opts.gfm ?? true, breaks: false, async: false })
}