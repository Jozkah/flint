import { describe, it, expect } from 'vitest'
import type { Element, Root } from 'hast'
import rehypeRaw from 'rehype-raw'
import { rehypeSafeInlineHtml, sanitizeStyle } from '../rehypeSafeInlineHtml'

// Parse raw HTML the way the model pipeline does (rehype-raw), then clean it.
function clean(html: string): Root {
  const raw = { type: 'root', children: [{ type: 'raw', value: html }] } as unknown as Root
  const tree = (rehypeRaw() as unknown as (t: Root) => Root)(raw)
  rehypeSafeInlineHtml()(tree)
  return tree
}

function find(node: Root | Element, tag: string): Element | undefined {
  for (const child of node.children) {
    if (child.type !== 'element') continue
    if (child.tagName === tag) return child
    const hit = find(child, tag)
    if (hit) return hit
  }
  return undefined
}

const el = (tagName: string, properties: Element['properties'], children: Element['children'] = []) =>
  ({ type: 'element', tagName, properties, children }) as Element

describe('rehypeSafeInlineHtml', () => {
  // Characterization: ordinary markdown output must pass through untouched.
  it('keeps markdown-generated elements and their properties', () => {
    const tree: Root = {
      type: 'root',
      children: [
        el('pre', {}, [el('code', { className: ['language-ts'] })]),
        el('a', { href: '#fn-1', id: 'fnref-1', dataFootnoteRef: true, ariaDescribedBy: ['footnote-label'] }),
        el('input', { type: 'checkbox', checked: true, disabled: true }),
        el('ol', { start: 3 }),
        el('td', { align: 'center' }),
        el('img', { src: 'https://example.com/a.png', alt: 'a', title: 't' }),
      ],
    }
    const before = JSON.parse(JSON.stringify(tree))
    rehypeSafeInlineHtml()(tree)
    expect(tree).toEqual(before)
  })

  it('removes scripts, handlers and srcdoc and trims style', () => {
    const tree = clean(
      '<span style="color:red;position:fixed" onclick="x()">hi</span><script>bad()</script><iframe srcdoc="x"></iframe>'
    )
    const span = find(tree, 'span')!
    expect(span.properties).toEqual({ style: 'color: red' })
    expect(find(tree, 'script')).toBeUndefined()
    expect(find(tree, 'iframe')).toBeUndefined()
  })

  it('drops media, svg, math and form controls with their content', () => {
    const tree = clean(
      '<p>a<svg><image href="https://x/y.png"></image></svg><math><mi>x</mi></math><video src="https://x/v.mp4"><track src="https://x/t.vtt"></video><audio src="https://x/a.mp3"></audio><picture><source srcset="https://x/p.png"></picture><button>b</button><textarea>t</textarea><select><option>o</option></select><input type="text" value="v">z</p>'
    )
    for (const tag of ['svg', 'image', 'math', 'video', 'track', 'audio', 'picture', 'source', 'button', 'textarea', 'select', 'input']) {
      expect(find(tree, tag), tag).toBeUndefined()
    }
    const p = find(tree, 'p')!
    expect(p.children.map((c) => (c.type === 'text' ? c.value : ''))).toEqual(['a', 'z'])
  })

  it('keeps only allowlisted attributes', () => {
    const tree = clean(
      '<img src="https://x/a.png" srcset="https://x/b.png 2x" alt="a" loading="eager"><table background="https://x/bg.png"><tr><td colspan="2" rowspan="1" background="https://x/c.png">c</td></tr></table><a href="https://x" ping="https://track" target="_top">l</a>'
    )
    expect(find(tree, 'img')!.properties).toEqual({ src: 'https://x/a.png', alt: 'a' })
    expect(find(tree, 'table')!.properties).toEqual({})
    expect(find(tree, 'td')!.properties).toEqual({ colSpan: '2', rowSpan: 1 })
    expect(find(tree, 'a')!.properties).toEqual({ href: 'https://x' })
  })

  it('strips unsafe href and src schemes', () => {
    const tree = clean(
      '<a href="javascript:alert(1)">j</a><a href=" JaVaScRiPt:alert(1)">k</a><a href="mailto:a@b.c">m</a><a href="#x">h</a><img src="data:image/png;base64,AA" alt="d"><img src="file:///etc/passwd" alt="f">'
    )
    const hrefs: unknown[] = []
    const walk = (n: Root | Element) => {
      for (const c of n.children) {
        if (c.type !== 'element') continue
        if (c.tagName === 'a') hrefs.push(c.properties.href)
        if (c.tagName === 'img') hrefs.push(c.properties.src)
        walk(c)
      }
    }
    walk(tree)
    expect(hrefs).toEqual([undefined, undefined, 'mailto:a@b.c', '#x', 'data:image/png;base64,AA', undefined])
  })

  it('keeps data-* and aria-* attributes', () => {
    const tree = clean('<span data-x="1" aria-label="l" class="c" title="t">s</span>')
    expect(find(tree, 'span')!.properties).toEqual({ dataX: '1', ariaLabel: 'l', className: ['c'], title: 't' })
  })
})

describe('sanitizeStyle', () => {
  it('drops url() and unknown properties', () => {
    expect(sanitizeStyle('color: red; background: url(https://x); position: absolute')).toBe('color: red')
  })
})
