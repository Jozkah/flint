import { useEffect, useRef } from 'react'
import {
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  type Extension,
} from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { loadEditorLanguage } from '@/lib/codeEditorLanguages'
import type { BlameCommit, ChangeHunk } from '@/lib/codeGutter'
import { gitOverlays, setBlame, setHunks } from './codeEditorGit'

/**
 * The Code panel's editor: CodeMirror 6 with undo/redo, find (Ctrl+F),
 * bracket matching, folding and the same One Dark / One Light palette the
 * read-only viewer's Shiki themes use, so switching a file from reading to
 * editing does not recolour it.
 *
 * Controlled loosely: `value` seeds the document and replaces it when it
 * changes from outside (a reload or a discard); typing reports through
 * `onChange` without the parent having to echo it back.
 */
export type CodeEditorProps = {
  /** Identifies the document. A new key starts a fresh editor state (and
   * a fresh undo history), the way switching files does in an IDE. */
  docKey: string
  value: string
  /** Shiki language id from `detectLanguage`. */
  lang: string
  wordWrap: boolean
  isDark: boolean
  ariaLabel: string
  onChange: (text: string) => void
  /** Ctrl+S / Cmd+S. */
  onSave: () => void
  /** The selected lines, for "Add to chat"; null when nothing is selected. */
  onSelection?: (
    span: { startLine: number; endLine: number; code: string } | null
  ) => void
  /** Scroll to and place the cursor on this 1-based line. `at` makes a
   * repeat request for the same line move there again. */
  reveal?: { line: number; at: number } | null
  /** Change markers against HEAD (or the original); empty hides them. */
  hunks?: ChangeHunk[]
  /** Blame per 1-based line, and how to label a commit; null hides it. */
  blame?: {
    lines: (BlameCommit | undefined)[]
    label: (commit: BlameCommit) => string
  } | null
  onHunk?: (hunk: ChangeHunk) => void
  onBlameHover?: (commit: BlameCommit, el: HTMLElement | null) => void
}

/** One Dark Pro / One Light, the palettes behind the viewer's Shiki themes. */
const PALETTE = {
  dark: {
    keyword: '#c678dd',
    string: '#98c379',
    number: '#d19a66',
    comment: '#7f848e',
    function: '#61afef',
    type: '#e5c07b',
    variable: '#e06c75',
    property: '#e06c75',
    operator: '#56b6c2',
    tag: '#e06c75',
    attribute: '#d19a66',
    meta: '#abb2bf',
    invalid: '#ffffff',
  },
  light: {
    keyword: '#a626a4',
    string: '#50a14f',
    number: '#986801',
    comment: '#a0a1a7',
    function: '#4078f2',
    type: '#c18401',
    variable: '#e45649',
    property: '#e45649',
    operator: '#0184bc',
    tag: '#e45649',
    attribute: '#986801',
    meta: '#383a42',
    invalid: '#ca1243',
  },
} as const

function highlightFor(isDark: boolean): Extension {
  const c = isDark ? PALETTE.dark : PALETTE.light
  return syntaxHighlighting(
    HighlightStyle.define([
      { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword], color: c.keyword },
      { tag: [tags.string, tags.special(tags.string), tags.regexp], color: c.string },
      { tag: [tags.number, tags.bool, tags.null, tags.atom], color: c.number },
      { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: c.comment, fontStyle: 'italic' },
      { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: c.function },
      { tag: [tags.typeName, tags.className, tags.namespace, tags.definition(tags.typeName)], color: c.type },
      { tag: [tags.variableName, tags.self], color: c.variable },
      { tag: [tags.propertyName], color: c.property },
      { tag: [tags.operator, tags.punctuation], color: c.operator },
      { tag: [tags.tagName], color: c.tag },
      { tag: [tags.attributeName], color: c.attribute },
      { tag: [tags.heading], color: c.variable, fontWeight: 'bold' },
      { tag: [tags.link, tags.url], color: c.function, textDecoration: 'underline' },
      { tag: [tags.meta, tags.processingInstruction], color: c.meta },
      { tag: [tags.invalid], color: c.invalid },
    ])
  )
}

const baseTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12px',
    backgroundColor: 'transparent',
    color: 'var(--color-foreground)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    lineHeight: '1.6',
    overscrollBehavior: 'contain',
  },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--color-foreground)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--color-subtle-foreground, #999)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'color-mix(in oklab, var(--color-foreground) 5%, transparent)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklab, var(--color-ring, #3b82f6) 30%, transparent) !important',
  },
  '.cm-panels': {
    backgroundColor: 'var(--color-card)',
    color: 'var(--color-foreground)',
    borderColor: 'var(--color-border)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in oklab, #e5c07b 35%, transparent)',
  },
})

export function CodeEditor({
  docKey,
  value,
  lang,
  wordWrap,
  isDark,
  ariaLabel,
  onChange,
  onSave,
  onSelection,
  reveal,
  hunks,
  blame,
  onHunk,
  onBlameHover,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const language = useRef(new Compartment())
  const theme = useRef(new Compartment())
  const wrap = useRef(new Compartment())
  // Latest callbacks, read by extensions built once per document.
  const handlers = useRef({ onChange, onSave, onSelection, onHunk, onBlameHover })
  handlers.current = { onChange, onSave, onSelection, onHunk, onBlameHover }

  const buildState = (doc: string) =>
    EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                handlers.current.onSave()
                return true
              },
            },
          ])
        ),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            handlers.current.onChange(update.state.doc.toString())
          }
          if (update.selectionSet || update.docChanged) {
            const report = handlers.current.onSelection
            if (!report) return
            const range = update.state.selection.main
            if (range.empty) {
              report(null)
              return
            }
            const doc = update.state.doc
            report({
              startLine: doc.lineAt(range.from).number,
              endLine: doc.lineAt(range.to).number,
              code: doc.sliceString(range.from, range.to),
            })
          }
        }),
        baseTheme,
        gitOverlays({
          onHunk: (hunk) => handlers.current.onHunk?.(hunk),
          onBlameHover: (commit, el) =>
            handlers.current.onBlameHover?.(commit, el),
        }),
        theme.current.of(highlightFor(isDark)),
        wrap.current.of(wordWrap ? EditorView.lineWrapping : []),
        language.current.of([]),
      ],
    })

  // One view for the component's life; a new document swaps its state.
  useEffect(() => {
    if (!host.current) return
    const created = new EditorView({ state: buildState(value), parent: host.current })
    view.current = created
    return () => {
      created.destroy()
      view.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A different file: a fresh state, so undo never crosses files.
  const lastKey = useRef(docKey)
  useEffect(() => {
    const v = view.current
    if (!v || lastKey.current === docKey) return
    lastKey.current = docKey
    v.setState(buildState(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey])

  // The same file replaced from outside (reload, discard).
  useEffect(() => {
    const v = view.current
    if (!v) return
    const current = v.state.doc.toString()
    if (current === value) return
    v.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  useEffect(() => {
    view.current?.dispatch({ effects: setHunks.of(hunks ?? []) })
  }, [hunks, docKey])

  useEffect(() => {
    view.current?.dispatch({ effects: setBlame.of(blame ?? null) })
  }, [blame, docKey])

  useEffect(() => {
    let alive = true
    void loadEditorLanguage(lang).then((ext) => {
      if (!alive || !view.current) return
      view.current.dispatch({
        effects: language.current.reconfigure(ext ?? []),
      })
    })
    return () => {
      alive = false
    }
  }, [lang, docKey])

  useEffect(() => {
    view.current?.dispatch({
      effects: theme.current.reconfigure(highlightFor(isDark)),
    })
  }, [isDark, docKey])

  useEffect(() => {
    view.current?.dispatch({
      effects: wrap.current.reconfigure(
        wordWrap ? EditorView.lineWrapping : []
      ),
    })
  }, [wordWrap, docKey])

  useEffect(() => {
    const v = view.current
    if (!v || !reveal) return
    const doc = v.state.doc
    const line = doc.line(Math.min(Math.max(1, reveal.line), doc.lines))
    v.dispatch({
      selection: EditorSelection.cursor(line.from),
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    })
    // Keyed on the request's fields: a new object for the same request must
    // not move the cursor back while the user types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.line, reveal?.at, docKey])

  return (
    <div
      ref={host}
      className="h-full min-h-0 min-w-0 overflow-hidden"
      data-testid="code-editor"
    />
  )
}

export default CodeEditor
