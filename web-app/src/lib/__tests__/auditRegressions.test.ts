import { describe, expect, it, beforeEach } from 'vitest'
import { toneForTool } from '@/lib/semanticTone'
import {
  acceptAttribute,
  validateAttachment,
} from '@/lib/attachmentSupport'
import { isTypingTarget } from '@/lib/fileDrop'
import {
  deriveFromSubagent,
  deriveFromTurns,
  eventFromTool,
  mergeEvents,
} from '@/lib/fileActivity'
import { useFileActivity } from '@/hooks/useFileActivity'

/**
 * Regressions for defects the adversarial audit found. Each of these passed
 * its own unit tests while being wrong, or unreachable, in production.
 */

const projectOrigin = () => 'project' as const

describe('a settled transcript is not a wall of green', () => {
  it('keeps a finished read cyan rather than recolouring it success', () => {
    // Every completed tool used to become `success`, so once a turn settled
    // the whole transcript was green and read/write were indistinguishable.
    expect(toneForTool({ name: 'read', state: 'output-available' })).toBe('read')
    expect(toneForTool({ name: 'grep', state: 'output-available' })).toBe('read')
    expect(toneForTool({ name: 'bash', state: 'output-available' })).toBe('tool')
  })

  it('still lets a failure outrank everything', () => {
    expect(toneForTool({ name: 'read', state: 'output-error' })).toBe('error')
  })

  it('still settles a write out of its urgent amber', () => {
    expect(toneForTool({ name: 'write', state: 'input-available' })).toBe('write')
    expect(toneForTool({ name: 'write', state: 'output-available' })).toBe(
      'success'
    )
  })
})

describe('documents are not advertised where they cannot be read', () => {
  it('offers no document extensions to the browser picker', () => {
    // The local parser reads by path; a dropped File has none. Offering .pdf
    // there promised something the intake structurally cannot deliver.
    const browser = acceptAttribute({ vision: true }, 'browser')
    expect(browser).not.toContain('.pdf')
    expect(browser).not.toContain('.docx')
    expect(browser).toContain('.ts')
  })

  it('offers them to the file dialog, which yields a path', () => {
    const dialog = acceptAttribute({}, 'path')
    expect(dialog).toContain('.pdf')
    expect(dialog).toContain('.xlsx')
  })

  it('names the real reason when one is dropped anyway', () => {
    // Not "unsupported" — the app parses PDFs perfectly well.
    expect(
      validateAttachment({ name: 'a.pdf', size: 10, type: '' }, {
        capabilities: {},
      }).reason
    ).toBe('needs-file-dialog')
  })

  it('accepts one that arrived through the dialog', () => {
    expect(
      validateAttachment({ name: 'a.pdf', size: 10, type: '' }, {
        capabilities: {},
        intake: 'path',
      })
    ).toEqual({ ok: true, kind: 'document' })
  })
})

describe('the open shortcut does not interrupt typing', () => {
  const el = (tag: string, attrs: Record<string, string> = {}) => {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
    document.body.appendChild(node)
    return node
  }

  it('recognises the places a keystroke belongs to the user', () => {
    expect(isTypingTarget(el('textarea'))).toBe(true)
    expect(isTypingTarget(el('input'))).toBe(true)
    expect(isTypingTarget(el('select'))).toBe(true)
  })

  it('recognises a rich-text editor', () => {
    const node = el('div')
    Object.defineProperty(node, 'isContentEditable', { value: true })
    expect(isTypingTarget(node)).toBe(true)
  })

  it('leaves an open dialog and menu alone', () => {
    const dialog = el('div', { role: 'dialog' })
    const inner = document.createElement('span')
    dialog.appendChild(inner)
    expect(isTypingTarget(inner)).toBe(true)
  })

  it('allows the shortcut over ordinary content', () => {
    expect(isTypingTarget(el('div'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('recording the same tool call twice', () => {
  const record = {
    callId: 'call-1',
    name: 'write',
    args: { path: 'src/a.ts' },
  }

  it('produces one event whether it is seen once or twice', () => {
    // A call settles as its step lands, and is seen again when the turn is
    // committed. A batch-relative id made those two different events.
    const fromStep = eventFromTool(record, 0, 100, projectOrigin)!
    const fromCommit = eventFromTool(record, 7, 200, projectOrigin)!
    expect(fromStep.id).toBe(fromCommit.id)
    expect(mergeEvents([fromStep], [fromCommit])).toHaveLength(1)
  })

  it('dedupes through the store, across separate recordings', () => {
    useFileActivity.setState({ byConversation: {} })
    const store = () => useFileActivity.getState()
    store().record('s1', deriveFromTurns([record], projectOrigin, 100))
    store().record('s1', deriveFromTurns([record], projectOrigin, 200))
    expect(store().eventsFor('s1')).toHaveLength(1)
  })
})

describe('subagent file work', () => {
  it('carries the subagent’s name', () => {
    const events = deriveFromSubagent(
      'reviewer',
      [{ callId: 'c1', name: 'read', args: { path: 'a.ts' } }],
      projectOrigin
    )
    expect(events[0].agent).toBe('reviewer')
  })

  it('does not overwrite an agent already recorded', () => {
    const events = deriveFromSubagent(
      'reviewer',
      [{ callId: 'c1', name: 'read', args: { path: 'a.ts' }, agent: 'inner' }],
      projectOrigin
    )
    expect(events[0].agent).toBe('inner')
  })

  it('keeps main-agent work unlabelled', () => {
    const events = deriveFromTurns(
      [{ callId: 'c1', name: 'read', args: { path: 'a.ts' } }],
      projectOrigin
    )
    expect(events[0].agent).toBeUndefined()
  })
})

describe('a still-running operation is not recorded as done', () => {
  beforeEach(() => useFileActivity.setState({ byConversation: {} }))

  it('records nothing while the call is in flight', () => {
    const store = () => useFileActivity.getState()
    store().record(
      's1',
      deriveFromTurns(
        [{ callId: 'c1', name: 'write', args: { path: 'a.ts' }, status: 'running' }],
        projectOrigin
      )
    )
    expect(store().eventsFor('s1')).toEqual([])
  })

  it('records it once it settles, and marks a failure as failed', () => {
    const store = () => useFileActivity.getState()
    store().record(
      's1',
      deriveFromTurns(
        [{ callId: 'c1', name: 'write', args: { path: 'a.ts' }, isError: true }],
        projectOrigin
      )
    )
    const [event] = store().eventsFor('s1')
    expect(event.ok).toBe(false)
  })
})
