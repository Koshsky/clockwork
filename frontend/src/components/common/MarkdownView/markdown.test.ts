/**
 * Unit tests for the safe Markdown renderer (src/components/common/MarkdownView/
 * markdown.ts): the output must never contain raw HTML or unsafe URLs, while
 * regular Markdown (lists, code, tables, links) renders as expected.
 */
import { describe, expect, it } from 'vitest'
import { escapeHtml, isSafeUrl, renderMarkdown } from './markdown'

describe('isSafeUrl', () => {
  it('accepts http/https/mailto and scheme-less URLs', () => {
    expect(isSafeUrl('https://example.com')).toBe(true)
    expect(isSafeUrl('http://example.com')).toBe(true)
    expect(isSafeUrl('mailto:admin@example.com')).toBe(true)
    expect(isSafeUrl('/relative/path')).toBe(true)
    expect(isSafeUrl('#anchor')).toBe(true)
  })

  it('rejects scripts, data URIs and empty strings', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeUrl('JaVaScRiPt:alert(1)')).toBe(false)
    expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeUrl('vbscript:msgbox(1)')).toBe(false)
    expect(isSafeUrl('')).toBe(false)
    expect(isSafeUrl('   ')).toBe(false)
  })
})

describe('escapeHtml', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    )
  })
})

describe('renderMarkdown', () => {
  it('renders paragraphs, emphasis and inline code', () => {
    const html = renderMarkdown('Текст с **жирным**, *курсивом* и `кодом`.')
    expect(html).toContain('<p>')
    expect(html).toContain('<strong>жирным</strong>')
    expect(html).toContain('<em>курсивом</em>')
    expect(html).toContain('<code>кодом</code>')
  })

  it('renders bullet and ordered lists', () => {
    const html = renderMarkdown('- один\n- два\n\n1. раз\n2. два')
    expect(html).toContain('<ul>')
    expect(html).toContain('<ol>')
    expect(html).toContain('<li>один</li>')
    expect(html).toContain('<li>раз</li>')
  })

  it('renders fenced code blocks', () => {
    const html = renderMarkdown('```\nПроект → Процесс → Задача\n```')
    expect(html).toContain('<pre>')
    expect(html).toContain('<code>')
    expect(html).toContain('Проект → Процесс → Задача')
  })

  it('renders GFM tables when enabled', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>a</th>')
  })

  it('escapes raw HTML instead of emitting it', () => {
    const html = renderMarkdown('<script>alert("xss")</script>\n\n<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('neutralizes javascript: links and renders safe links with noopener', () => {
    const html = renderMarkdown('[плохо](javascript:alert(1)) и [хорошо](https://example.com)')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('alert(')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('target="_blank"')
    // The unsafe link keeps its visible label as plain text (no href emitted).
    expect(html).not.toContain('href="плохо"')
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">хорошо</a>')
  })

  it('neutralizes images into escaped alt text (no <img>)', () => {
    const html = renderMarkdown('![трекер](https://example.com/x.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('[трекер]')
  })

  it('empty input renders empty output', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('   ').trim()).toBe('')
  })
})

describe('Markdown URL XSS regressions', () => {
  it.each([
    'java\tscript:alert(1)', 'java\nscript:alert(1)', 'java\rscript:alert(1)',
    '\u0000javascript:alert(1)', ' JAVASCRIPT:alert(1)', 'data:text/html,test',
    'vbscript:msgbox(1)', 'file:///etc/passwd', 'http://',
  ])('rejects browser-normalized unsafe URL %j', url => {
    expect(isSafeUrl(url)).toBe(false)
  })

  it('does not emit an anchor for the embedded-tab bypass', () => {
    const html = renderMarkdown('[probe](<java\tscript:alert(1)>)')
    expect(html).not.toContain('<a ')
    expect(html).toContain('probe')
  })

  it.each(['../page', '?search=a%20b', '#section', 'https://example.com/a b', 'MAILTO:user@example.com'])('keeps legitimate URL %s', url => {
    expect(isSafeUrl(url)).toBe(true)
  })
})
