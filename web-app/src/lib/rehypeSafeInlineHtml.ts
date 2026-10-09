import type { Element, Root, RootContent } from 'hast'

// Raw HTML from a model is untrusted. This runs after rehype-raw, so the tree
// also holds ordinary markdown output (code, tables, links...) that must pass
// through untouched. Active content is removed (script/iframe/..., on* handlers,
// srcdoc) and every `style` is cut down to safe colour/typography declarations.

// Elements whose content must disappear with the tag.
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'noscript',
  'template',
  'title',
  'link',
  'meta',
  'base',
  'form',
  'frame',
  'frameset',
  'applet',
])

const ALLOWED_STYLE_PROPS = new Set([
  'color',
  'background',
  'background-color',
  'font-weight',
  'font-style',
  'font-size',
  'text-decoration',
  'text-decoration-color',
  'text-align',
  'border',
  'border-radius',
  'border-color',
  'padding',
  'padding-left',
  'padding-right',
  'padding-top',
  'padding-bottom',
  'display',
  'opacity',
])

const SAFE_DISPLAY = new Set(['inline', 'inline-block', 'block'])

// Colour keywords, hex, rgb()/hsl() and plain lengths/numbers only. Rejecting
// any `url`/`expression`/`var`/`calc`/`@`/`\` blocks resource loads.
const SAFE_VALUE = /^[#a-z0-9%.,\s()+/-]+$/i
const UNSAFE_VALUE = /url\s*\(|expression|var\s*\(|calc\s*\(|image|@|\\/i

export function sanitizeStyle(style: string): string {
  const out: string[] = []
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':')
    if (idx === -1) continue
    const prop = decl.slice(0, idx).trim().toLowerCase()
    const value = decl.slice(idx + 1).trim()
    if (!ALLOWED_STYLE_PROPS.has(prop) || !value) continue
    if (!SAFE_VALUE.test(value) || UNSAFE_VALUE.test(value)) continue
    if (prop === 'display' && !SAFE_DISPLAY.has(value.toLowerCase())) continue
    out.push(`${prop}: ${value}`)
  }
  return out.join('; ')
}

function cleanProperties(props: Element['properties']): Element['properties'] {
  const out: Element['properties'] = {}
  for (const [key, value] of Object.entries(props ?? {})) {
    const k = key.toLowerCase()
    if (k.startsWith('on') || k === 'srcdoc') continue
    if (k === 'style') {
      const style = typeof value === 'string' ? sanitizeStyle(value) : ''
      if (style) out.style = style
      continue
    }
    out[key] = value
  }
  return out
}

function cleanChildren(children: RootContent[]): RootContent[] {
  const result: RootContent[] = []
  for (const child of children) {
    if (child.type === 'element') {
      if (DROP_WITH_CONTENT.has(child.tagName)) continue
      child.children = cleanChildren(
        child.children as RootContent[]
      ) as Element['children']
      child.properties = cleanProperties(child.properties)
      result.push(child)
    } else if (child.type === 'comment' || child.type === 'doctype') {
      continue
    } else {
      result.push(child)
    }
  }
  return result
}

export function rehypeSafeInlineHtml() {
  return (tree: Root) => {
    tree.children = cleanChildren(tree.children) as Root['children']
  }
}
