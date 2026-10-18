import { describe, it, expect } from 'vitest'
import type { Root } from 'hast'
import { rehypeStripFlankingZwsp } from '../rehypeStripFlankingZwsp'

const Z = '​'
const text = (value: string) => ({ type: 'text' as const, value })
const el = (tagName: string, children: unknown[]) =>
  ({ type: 'element', tagName, properties: {}, children }) as never

// C049: the U+200B the renderer adds so "word**,**" parses as bold stayed in
// the DOM, and a copied selection carried it.
describe('rehypeStripFlankingZwsp', () => {
  it('removes the space next to bold or italic, outside and inside', () => {
    const tree: Root = {
      type: 'root',
      children: [
        el('p', [
          text(`a${Z}`),
          el('strong', [text(`${Z}bold${Z}`)]),
          text(`${Z}.`),
          el('em', [text('x')]),
        ]),
      ],
    }
    rehypeStripFlankingZwsp()(tree)
    const p = tree.children[0] as { children: { value?: string; children?: { value: string }[] }[] }
    expect(p.children[0].value).toBe('a')
    expect(p.children[1].children![0].value).toBe('bold')
    expect(p.children[2].value).toBe('.')
  })

  it('keeps one elsewhere and inside code', () => {
    const tree: Root = {
      type: 'root',
      children: [el('p', [text(`a${Z}b`), el('code', [text(`${Z}`)])])],
    }
    rehypeStripFlankingZwsp()(tree)
    const p = tree.children[0] as { children: { value?: string; children?: { value: string }[] }[] }
    expect(p.children[0].value).toBe(`a${Z}b`)
    expect(p.children[1].children![0].value).toBe(Z)
  })
})
