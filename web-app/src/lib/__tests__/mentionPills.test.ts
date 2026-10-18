import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { TextSelection } from '@tiptap/pm/state'
import {
  MentionPills,
  docMentionRanges,
  handlePillKey,
  setMentionLabels,
  slugTitle,
} from '@/lib/mentionPills'
import {
  compactCount,
  findMentionRanges,
  mentionTokens,
  mentionsTooLarge,
} from '@/lib/mentionDisplay'

const TOKEN = 'chat:codeword-confirmation-pineapple-56af074f'

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function make(markdown: string) {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit,
      Markdown,
      MentionPills.configure({
        describe: (kind, title) => `${kind}: ${title}`,
      }),
    ],
    content: markdown,
    contentType: 'markdown',
  })
  return editor
}

const key = (e: Editor, k: string) =>
  handlePillKey(e.view, new KeyboardEvent('keydown', { key: k }))

const caret = (e: Editor, pos: number) =>
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, pos)))

describe('findMentionRanges', () => {
  it('finds tokens as the send path reads them, not escaped or mid-word', () => {
    const text = `see @${TOKEN} and @room:team-1234abcd#summary, a@chat:x-1 \\@chat:y-2`
    const r = findMentionRanges(text)
    expect(r.map((x) => x.token)).toEqual([TOKEN, 'room:team-1234abcd#summary'])
    expect(text.slice(r[0].start, r[0].end)).toBe(`@${TOKEN}`)
    expect(r[1].kind).toBe('room')
  })
})

describe('token pills in the editor', () => {
  it('draws the token as a pill with the title, and keeps the text', () => {
    const e = make(`look at @${TOKEN} now`)
    setMentionLabels(e.view, new Map([[TOKEN, { status: 'ok', title: 'Codeword Confirmation PINEAPPLE-42' }]]))
    const pill = e.view.dom.querySelector('[data-testid="mention-pill"]') as HTMLElement
    expect(pill).toBeTruthy()
    expect(pill.textContent).toBe('Codeword Confirmation PINEAPPLE-42')
    expect(pill.getAttribute('aria-label')).toBe('chat: Codeword Confirmation PINEAPPLE-42')
    expect(pill.getAttribute('contenteditable')).toBe('false')
    expect(e.view.dom.querySelector('.mention-raw')?.getAttribute('aria-hidden')).toBe('true')
    // Serialization is untouched.
    expect(e.getMarkdown()).toBe(`look at @${TOKEN} now`)
  })

  it('shows the readable slug while the title is still loading', () => {
    const e = make(`@${TOKEN}`)
    const pill = e.view.dom.querySelector('[data-testid="mention-pill"]') as HTMLElement
    expect(pill.dataset.status).toBe('loading')
    expect(pill.textContent).toBe('codeword confirmation pineapple')
    expect(slugTitle('session:abc12345')).toBe('abc12345')
  })

  it('leaves tokens inside code alone', () => {
    const e = make('`@' + TOKEN + '`')
    expect(docMentionRanges(e.state.doc)).toHaveLength(0)
    expect(e.view.dom.querySelector('[data-testid="mention-pill"]')).toBeNull()
  })

  it('Backspace after a pill removes the whole token', () => {
    const e = make(`hi @${TOKEN} x`)
    const [r] = docMentionRanges(e.state.doc)
    caret(e, r.to)
    expect(key(e, 'Backspace')).toBe(true)
    expect(e.getMarkdown()).toBe('hi  x')
  })

  it('Delete before a pill removes the whole token', () => {
    const e = make(`hi @${TOKEN} x`)
    const [r] = docMentionRanges(e.state.doc)
    caret(e, r.from)
    expect(key(e, 'Delete')).toBe(true)
    expect(e.getMarkdown()).toBe('hi  x')
  })

  it('Backspace elsewhere is left to the editor', () => {
    const e = make(`hi @${TOKEN} x`)
    caret(e, 2)
    expect(key(e, 'Backspace')).toBe(false)
  })

  it('arrow keys step over a pill', () => {
    const e = make(`hi @${TOKEN} x`)
    const [r] = docMentionRanges(e.state.doc)
    caret(e, r.from)
    expect(key(e, 'ArrowRight')).toBe(true)
    expect(e.state.selection.head).toBe(r.to)
    expect(key(e, 'ArrowLeft')).toBe(true)
    expect(e.state.selection.head).toBe(r.from)
  })

  it('never leaves the caret inside a token', () => {
    const e = make(`hi @${TOKEN} x`)
    const [r] = docMentionRanges(e.state.doc)
    caret(e, r.from)
    caret(e, r.from + 3)
    expect(e.state.selection.head).toBe(r.to)
    caret(e, r.to - 2)
    expect(e.state.selection.head).toBe(r.from)
  })
})

describe('token costs', () => {
  it('estimates excerpt tokens with the shared estimator, a summary capped', () => {
    expect(mentionTokens(398, false)).toBe(114)
    expect(mentionTokens(398, true)).toBe(114)
    expect(mentionTokens(20000, true)).toBe(1024)
  })

  it('warns above a quarter of the window, never without one', () => {
    expect(mentionsTooLarge(2049, 8192)).toBe(true)
    expect(mentionsTooLarge(2048, 8192)).toBe(false)
    expect(mentionsTooLarge(99999, null)).toBe(false)
    expect(mentionsTooLarge(99999, 0)).toBe(false)
  })

  it('formats counts compactly', () => {
    expect(compactCount(398, 'en')).toBe('398')
    expect(compactCount(1234, 'en')).toBe('1.2K')
  })
})

describe('pill styles', () => {
  it('keep a pill on one line, truncated, and the raw token hidden', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const css = readFileSync(resolve(__dirname, '../../styles/mentions.css'), 'utf8')
    const rule = (sel: string) => {
      const i = css.indexOf(`
${sel} {`)
      return i === -1 ? '' : css.slice(i, css.indexOf('}', i))
    }
    expect(rule('.mention-raw')).toContain('display: none')
    expect(rule('.mention-pill')).toMatch(/white-space: nowrap/)
    expect(rule('.mention-pill')).toMatch(/max-width: min\(18rem, 60%\)/)
    expect(rule('.mention-pill')).toMatch(/overflow: hidden/)
    expect(rule('.mention-pill-title')).toMatch(/text-overflow: ellipsis/)
    expect(rule('.mention-pill-title')).toMatch(/white-space: nowrap/)
    // ProseMirror resets non-editable nodes to white-space: normal; ours wins.
    expect(css).toMatch(/\.ProseMirror \.mention-pill,\s*\.ProseMirror \.mention-pill-title \{\s*white-space: nowrap/)
  })
})
