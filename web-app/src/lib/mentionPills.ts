/**
 * Draws the conversation mention tokens of the composer (`@chat:slug-id`) as
 * pills: the kind's icon and the conversation's title. Decorations only -- the
 * document still holds the plain token, so Markdown, copy/paste, the send path
 * and saved drafts are unchanged (docs/CHAT_MENTIONS.md). The caret never
 * stops inside a token: Backspace/Delete take the whole token, the arrow keys
 * step over it.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { idTag, parseMention, type MentionKind } from '@/lib/chatMentions'
import type { MentionPreview } from '@/lib/chatMentionPreview'
import { findMentionRanges } from '@/lib/mentionDisplay'

export type PillStatus = 'ok' | 'missing' | 'self' | 'over-cap' | 'loading'

export type PillLabel = {
  title?: string
  status: PillStatus
}

export type PillOptions = {
  /** What screen readers hear: e.g. "Chat: Release notes". */
  describe: (kind: MentionKind, title: string, status: PillStatus) => string
  /** The pointer or focus entered (`rect`) or left (`null`) a pill. */
  onHover: (token: string | null, rect: DOMRect | null) => void
}

type DocRange = { from: number; to: number; token: string; kind: MentionKind }
type PillState = { labels: ReadonlyMap<string, PillLabel>; deco: DecorationSet }

export const mentionPillKey = new PluginKey<PillState>('mentionPills')

/** The token ranges of a document, outside code. */
export function docMentionRanges(doc: PMNode): DocRange[] {
  const out: DocRange[] = []
  doc.descendants((node, pos, parent) => {
    if (node.type.spec.code) return false
    if (!node.isText || !node.text) return true
    if (parent?.type.spec.code) return false
    if (node.marks.some((m) => m.type.spec.code)) return false
    for (const r of findMentionRanges(node.text)) {
      out.push({ from: pos + r.start, to: pos + r.end, token: r.token, kind: r.kind })
    }
    return false
  })
  return out
}

/** The lookup for a token: its own, else one naming the same conversation. */
export function previewForToken(
  token: string,
  previews: readonly MentionPreview[]
): MentionPreview | undefined {
  const parsed = parseMention(token)
  return (
    previews.find((x) => x.token === token) ??
    previews.find(
      (x) => !!x.id && !!parsed && x.kind === parsed.kind && idTag(x.id) === parsed.tag
    )
  )
}

/** Labels for the pills of `tokens`; an unresolved token keeps the loading look. */
export function pillLabels(
  tokens: readonly string[],
  previews: readonly MentionPreview[]
): Map<string, PillLabel> {
  const out = new Map<string, PillLabel>()
  for (const token of tokens) {
    const p = previewForToken(token, previews)
    if (p) out.set(token, { status: p.status, title: p.title })
  }
  return out
}

/** Fallback text while a title is unknown: the slug, made readable. */
export function slugTitle(token: string): string {
  const body = token.replace(/^[a-z]+:/, '').replace(/#summary$/, '')
  const cut = body.lastIndexOf('-')
  const slug = cut === -1 ? body : body.slice(0, cut)
  return (slug || body).replace(/-/g, ' ')
}

const SVG: Record<MentionKind, string> = {
  chat: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  session: '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>',
  room: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
}

function pillDom(
  r: DocRange,
  label: PillLabel,
  opts: PillOptions
): HTMLElement {
  const title = label.title ?? slugTitle(r.token)
  const el = document.createElement('span')
  el.className = 'mention-pill'
  el.setAttribute('contenteditable', 'false')
  el.dataset.kind = r.kind
  el.dataset.status = label.status
  el.dataset.token = r.token
  el.setAttribute('data-testid', 'mention-pill')
  el.setAttribute('role', 'img')
  el.setAttribute('aria-label', opts.describe(r.kind, title, label.status))
  el.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SVG[r.kind]}</svg>`
  const text = document.createElement('span')
  text.className = 'mention-pill-title'
  text.textContent = title
  el.appendChild(text)
  const enter = () => opts.onHover(r.token, el.getBoundingClientRect())
  const leave = () => opts.onHover(null, null)
  el.addEventListener('mouseenter', enter)
  el.addEventListener('mouseleave', leave)
  return el
}

function build(
  doc: PMNode,
  labels: ReadonlyMap<string, PillLabel>,
  opts: PillOptions
): DecorationSet {
  const decos: Decoration[] = []
  for (const r of docMentionRanges(doc)) {
    const label = labels.get(r.token) ?? { status: 'loading' as const }
    decos.push(
      Decoration.inline(r.from, r.to, {
        class: 'mention-raw',
        'aria-hidden': 'true',
      }),
      Decoration.widget(r.from, () => pillDom(r, label, opts), {
        side: 1,
        ignoreSelection: true,
        key: `${r.token}|${label.status}|${label.title ?? ''}`,
      })
    )
  }
  return DecorationSet.create(doc, decos)
}

/** The token whose inside `pos` is, if any (its edges do not count). */
const inside = (ranges: DocRange[], pos: number) =>
  ranges.find((r) => pos > r.from && pos < r.to)

/** Tell the pills what each token names; the composer calls it as lookups land. */
export function setMentionLabels(
  view: EditorView,
  labels: ReadonlyMap<string, PillLabel>
) {
  view.dispatch(view.state.tr.setMeta(mentionPillKey, labels))
}

/** Backspace/Delete/arrows around a pill; true when handled. */
export function handlePillKey(view: EditorView, event: KeyboardEvent): boolean {
  const { state } = view
  const sel = state.selection
  if (!sel.empty || event.altKey || event.ctrlKey || event.metaKey) return false
  const head = sel.head
  const ranges = docMentionRanges(state.doc)
  const at = (edge: 'from' | 'to') => ranges.find((r) => r[edge] === head)
  const move = (pos: number) => {
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)))
    return true
  }
  switch (event.key) {
    case 'Backspace': {
      const r = at('to')
      if (!r) return false
      view.dispatch(state.tr.delete(r.from, r.to).scrollIntoView())
      return true
    }
    case 'Delete': {
      const r = at('from')
      if (!r) return false
      view.dispatch(state.tr.delete(r.from, r.to).scrollIntoView())
      return true
    }
    case 'ArrowLeft': {
      if (event.shiftKey) return false
      const r = at('to')
      return r ? move(r.from) : false
    }
    case 'ArrowRight': {
      if (event.shiftKey) return false
      const r = at('from')
      return r ? move(r.to) : false
    }
  }
  return false
}

/** Keep a collapsed caret out of a token: snap it to the edge it came from. */
function snapCaret(
  _trs: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState
): Transaction | null {
  const sel = newState.selection
  if (!sel.empty) return null
  const r = inside(docMentionRanges(newState.doc), sel.head)
  if (!r) return null
  const target = oldState.selection.head <= r.from ? r.to : r.from
  return newState.tr.setSelection(TextSelection.create(newState.doc, target))
}

export const MentionPills = Extension.create<PillOptions>({
  name: 'mentionPills',
  addOptions() {
    return {
      describe: (_kind, title) => title,
      onHover: () => {},
    }
  },
  addProseMirrorPlugins() {
    const opts = this.options
    return [
      new Plugin<PillState>({
        key: mentionPillKey,
        state: {
          init: (_config, state) => ({
            labels: new Map(),
            deco: build(state.doc, new Map(), opts),
          }),
          apply: (tr, prev) => {
            const labels =
              (tr.getMeta(mentionPillKey) as ReadonlyMap<string, PillLabel> | undefined) ??
              prev.labels
            if (!tr.docChanged && labels === prev.labels) return prev
            return { labels, deco: build(tr.doc, labels, opts) }
          },
        },
        appendTransaction: snapCaret,
        props: {
          decorations: (state) => mentionPillKey.getState(state)?.deco,
          handleKeyDown: (view, event) => handlePillKey(view, event),
          handleClickOn: (view, _pos, _node, _nodePos, event) => {
            const pill = (event.target as HTMLElement | null)?.closest?.('.mention-pill')
            if (!pill) return false
            // A click on a pill puts the caret after it.
            const token = (pill as HTMLElement).dataset.token
            const ranges = docMentionRanges(view.state.doc)
            let pos = -1
            try {
              pos = view.posAtDOM(pill, 0)
            } catch {
              pos = -1
            }
            const r =
              ranges.find((x) => x.from === pos) ??
              ranges.find((x) => x.token === token)
            if (!r) return false
            view.dispatch(
              view.state.tr.setSelection(TextSelection.create(view.state.doc, r.to))
            )
            return true
          },
        },
      }),
    ]
  },
})
