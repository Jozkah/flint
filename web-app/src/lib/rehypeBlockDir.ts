import type { Element, Root } from 'hast'

const AUTO_DIR = new Set([
  'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'td', 'th',
])

/**
 * Gives each markdown block its own `dir="auto"` so a mixed Arabic/Hebrew/
 * Persian and English message lays out every paragraph in its own direction,
 * not the direction of the message's first strong character (janhq/jan#9423).
 * Code blocks are pinned LTR and not descended into.
 */
export function rehypeBlockDir() {
  return (tree: Root) => {
    const visit = (parent: Root | Element) => {
      for (const node of parent.children) {
        if (node.type !== 'element') continue
        if (node.tagName === 'pre' || node.tagName === 'code') {
          node.properties = { ...node.properties, dir: 'ltr' }
          continue
        }
        if (AUTO_DIR.has(node.tagName) && node.properties?.dir == null) {
          node.properties = { ...node.properties, dir: 'auto' }
        }
        visit(node)
      }
    }
    visit(tree)
  }
}
