import type { Element, Root, RootContent } from 'hast'

// Raw HTML from a model is untrusted. This runs after rehype-raw, so the tree
// also holds ordinary markdown output (code, tables, links...) that must pass
// through untouched. Active content is removed (script/iframe/..., on* handlers,
// srcdoc, non-allowlisted attributes, unsafe URL schemes) and every `style` is cut down to safe colour/typography declarations.

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
  // Media and embedded documents load remote resources outside the image
  // click-to-load gate; form controls are not meaningful in a reply.
  'svg',
  'math',
  'video',
  'audio',
  'source',
  'track',
  'picture',
  'map',
  'area',
  'button',
  'select',
  'option',
  'textarea',
  'portal',
])

// hast property names (camelCase). Everything else is dropped, except data-*
// and aria-* attributes. Markdown output (footnotes, task lists, tables, code
// classes) only uses names from this list.
const ALLOWED_PROPS = new Set([
  'className',
  'id',
  'style',
  'href',
  'src',
  'alt',
  'title',
  'colSpan',
  'rowSpan',
  'align',
  'width',
  'height',
  'start',
  'reversed',
  'type',
  'checked',
  'disabled',
  'dir',
  'lang',
  'open',
])

// Links may go to the web, mail, phone, or stay on the page; images may be web
// or inline raster data. Anything else with a scheme (javascript:, file:...) goes.
const SAFE_HREF = /^(https?:|mailto:|tel:)/i
const SAFE_SRC = /^(https?:|data:image\/(png|jpe?g|gif|webp|avif);)/i

function safeUrl(value: unknown, allowed: RegExp): boolean {
  if (typeof value !== 'string') return false
  // Browsers ignore control chars and whitespace before the scheme.
  const v = value.replace(/[\s\p{Cc}]/gu, '')
  const colon = v.indexOf(':')
  if (colon === -1) return true
  const firstSep = v.search(/[/?#]/)
  if (firstSep !== -1 && firstSep < colon) return true
  return allowed.test(v)
}

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
    const dataOrAria = /^(data|aria)[A-Z]/.test(key)
    if (!dataOrAria && !ALLOWED_PROPS.has(key)) continue
    if (key === 'href' && !safeUrl(value, SAFE_HREF)) continue
    if (key === 'src' && !safeUrl(value, SAFE_SRC)) continue
    if (k === 'style') {
      const style = typeof value === 'string' ? sanitizeStyle(value) : ''
      if (style) out.style = style
      continue
    }
    out[key] = value
  }
  return out
}

// Task-list checkboxes from markdown are the only input kept.
function droppedInput(el: Element): boolean {
  return el.tagName === 'input' && el.properties?.type !== 'checkbox'
}

function cleanChildren(children: RootContent[]): RootContent[] {
  const result: RootContent[] = []
  for (const child of children) {
    if (child.type === 'element') {
      if (DROP_WITH_CONTENT.has(child.tagName) || droppedInput(child)) continue
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
