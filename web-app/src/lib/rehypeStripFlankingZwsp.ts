import type { Element, Root } from 'hast'

const ZWSP = '​'
const EMPHASIS = new Set(['strong', 'em', 'b', 'i'])

const isEmphasis = (node: unknown): node is Element =>
  (node as Element | undefined)?.type === 'element' &&
  EMPHASIS.has((node as Element).tagName)

/**
 * Removes the U+200B the renderer inserts so "word**,**" parses as emphasis
 * (`fixEmphasisFlanking`). Once parsed it has done its job; left in, it sat in
 * the DOM and every copied selection carried it (C049). Only a space touching
 * an emphasis boundary goes; code is left alone.
 */
export function rehypeStripFlankingZwsp() {
  return (tree: Root) => {
    const visit = (parent: Root | Element) => {
      const kids = parent.children
      const inEmphasis = parent.type === 'element' && EMPHASIS.has(parent.tagName)
      kids.forEach((node, i) => {
        if (node.type === 'element') {
          if (node.tagName !== 'code' && node.tagName !== 'pre') visit(node)
          return
        }
        if (node.type !== 'text' || !node.value.includes(ZWSP)) return
        let v = node.value
        if (v.startsWith(ZWSP) && ((inEmphasis && i === 0) || isEmphasis(kids[i - 1])))
          v = v.slice(1)
        if (
          v.endsWith(ZWSP) &&
          ((inEmphasis && i === kids.length - 1) || isEmphasis(kids[i + 1]))
        )
          v = v.slice(0, -1)
        node.value = v
      })
    }
    visit(tree)
  }
}
