/**
 * CodeMirror extensions for the Code panel's git overlays: the change gutter
 * (added / modified / deleted against HEAD) and the current line's blame
 * annotation. Data comes in through effects; the panel computes it.
 */
import {
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutter,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import {
  markersByLine,
  type BlameCommit,
  type ChangeHunk,
} from '@/lib/codeGutter'

export const setHunks = StateEffect.define<ChangeHunk[]>()
export const setBlame = StateEffect.define<{
  lines: (BlameCommit | undefined)[]
  label: (commit: BlameCommit) => string
} | null>()

const hunksField = StateField.define<Map<number, ChangeHunk>>({
  create: () => new Map(),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHunks)) return markersByLine(e.value)
    return value
  },
})

const blameField = StateField.define<{
  lines: (BlameCommit | undefined)[]
  label: (commit: BlameCommit) => string
} | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBlame)) return e.value
    return value
  },
})

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: ChangeHunk['kind']) {
    super()
  }
  eq(other: ChangeMarker) {
    return other.kind === this.kind
  }
  toDOM() {
    const el = document.createElement('div')
    el.className = `cm-change-${this.kind}`
    el.setAttribute('data-change', this.kind)
    return el
  }
}

const MARKERS = {
  added: new ChangeMarker('added'),
  modified: new ChangeMarker('modified'),
  deleted: new ChangeMarker('deleted'),
}

class BlameWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly commit: BlameCommit,
    readonly onHover: (commit: BlameCommit, el: HTMLElement | null) => void
  ) {
    super()
  }
  eq(other: BlameWidget) {
    return other.text === this.text && other.commit === this.commit
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-blame'
    el.textContent = this.text
    el.setAttribute('data-testid', 'blame-annotation')
    el.addEventListener('mouseenter', () => this.onHover(this.commit, el))
    el.addEventListener('mouseleave', () => this.onHover(this.commit, null))
    return el
  }
  ignoreEvent() {
    return false
  }
}

/**
 * The gutter and blame extensions. `onHunk` fires when a marker is clicked;
 * `onBlameHover` when the pointer enters (element) or leaves (null) the
 * annotation.
 */
export function gitOverlays(handlers: {
  onHunk: (hunk: ChangeHunk) => void
  onBlameHover: (commit: BlameCommit, el: HTMLElement | null) => void
}): Extension {
  const blamePlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = this.build(view)
      }
      update(u: ViewUpdate) {
        if (
          u.selectionSet ||
          u.docChanged ||
          u.startState.field(blameField) !== u.state.field(blameField)
        ) {
          this.decorations = this.build(u.view)
        }
      }
      build(view: EditorView): DecorationSet {
        const blame = view.state.field(blameField)
        if (!blame) return Decoration.none
        const line = view.state.doc.lineAt(view.state.selection.main.head)
        const commit = blame.lines[line.number]
        if (!commit) return Decoration.none
        return Decoration.set([
          Decoration.widget({
            widget: new BlameWidget(
              blame.label(commit),
              commit,
              handlers.onBlameHover
            ),
            side: 1,
          }).range(line.to),
        ])
      }
    },
    { decorations: (v) => v.decorations }
  )

  return [
    hunksField,
    blameField,
    gutter({
      class: 'cm-change-gutter',
      markers: (view) => {
        const byLine = view.state.field(hunksField)
        const ranges = []
        for (const [lineNo, hunk] of byLine) {
          if (lineNo > view.state.doc.lines) continue
          ranges.push(MARKERS[hunk.kind].range(view.state.doc.line(lineNo).from))
        }
        return RangeSet.of(ranges, true)
      },
      lineMarkerChange: (u) =>
        u.startState.field(hunksField) !== u.state.field(hunksField),
      domEventHandlers: {
        mousedown(view, block) {
          const lineNo = view.state.doc.lineAt(block.from).number
          const hunk = view.state.field(hunksField).get(lineNo)
          if (!hunk) return false
          handlers.onHunk(hunk)
          return true
        },
      },
    }),
    blamePlugin,
    EditorView.theme({
      '.cm-change-gutter': { width: '4px', cursor: 'pointer' },
      '.cm-change-gutter .cm-gutterElement': { padding: '0' },
      '.cm-change-added, .cm-change-modified': {
        width: '3px',
        height: '100%',
      },
      '.cm-change-added': { backgroundColor: 'var(--diff-add)' },
      '.cm-change-modified': { backgroundColor: 'var(--info)' },
      '.cm-change-deleted': {
        width: '0',
        height: '0',
        marginTop: 'calc(100% - 3px)',
        borderLeft: '5px solid var(--diff-del)',
        borderTop: '3px solid transparent',
        borderBottom: '3px solid transparent',
      },
      '.cm-blame': {
        marginLeft: '2.5em',
        opacity: '0.45',
        fontStyle: 'italic',
        color: 'var(--muted-foreground)',
        whiteSpace: 'pre',
      },
    }),
  ]
}
