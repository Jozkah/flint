import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRANSCRIPT_VIEW,
  interimTextParts,
  isQuietView,
  isTranscriptView,
  partitionTrace,
  TRANSCRIPT_VIEWS,
} from '../transcriptView'
import { interfacePersistOptions } from '@/hooks/interfaceSettings/persistence'

describe('transcript view modes', () => {
  it('orders the modes from quietest to loudest', () => {
    expect(TRANSCRIPT_VIEWS).toEqual(['zen', 'quiet', 'normal', 'thinking', 'verbose'])
    expect(DEFAULT_TRANSCRIPT_VIEW).toBe('normal')
  })

  it('recognises every mode and nothing else', () => {
    for (const view of TRANSCRIPT_VIEWS) expect(isTranscriptView(view)).toBe(true)
    for (const bad of ['loud', '', null, undefined, 3, {}])
      expect(isTranscriptView(bad)).toBe(false)
  })

  it('isQuietView is true for zen and quiet only', () => {
    expect(TRANSCRIPT_VIEWS.filter(isQuietView)).toEqual(['zen', 'quiet'])
  })
})

describe('partitionTrace in the quiet modes', () => {
  const part = (type: string, toolCallId: string, state = 'output-available') => ({
    part: { type, toolCallId, state },
    index: 0,
  })
  const entries = [
    { part: { type: 'reasoning' }, index: 0 },
    part('tool-read', 'ok'),
    part('tool-bash', 'bad', 'output-error'),
    part('tool-write', 'wait', 'input-available'),
    part('tool-open_in_browser', 'page'),
    part('tool-show_widget', 'widget', 'input-streaming'),
  ]
  const awaiting = (id: string) => id === 'wait'

  it.each(['quiet', 'zen'] as const)(
    '%s: no reasoning, failures and what needs the user stay out of the steps',
    (view) => {
      const out = partitionTrace(view, entries, awaiting)
      expect(out.reasoning).toEqual([])
      expect(out.steps.map((e) => e.part.toolCallId)).toEqual(['ok'])
      expect(out.pinned.map((e) => e.part.toolCallId).sort()).toEqual(
        ['bad', 'page', 'wait', 'widget'].sort()
      )
    }
  )

  it('a call awaiting approval is never a step, in any mode', () => {
    for (const view of ['zen', 'quiet', 'normal', 'thinking'] as const) {
      const out = partitionTrace(view, entries, awaiting)
      expect(out.steps.some((e) => e.part.toolCallId === 'wait')).toBe(false)
      expect(out.pinned.some((e) => e.part.toolCallId === 'wait')).toBe(true)
    }
  })

  it('normal still folds a failed call into the steps', () => {
    const out = partitionTrace('normal', entries, awaiting)
    expect(out.steps.map((e) => e.part.toolCallId)).toContain('bad')
  })
})

describe('interimTextParts', () => {
  const text = (value: string) => ({ type: 'text', text: value })
  const tool = { type: 'tool-read' }

  it('hides every text part but the last once the turn has ended', () => {
    const [a, b, c] = [text('looking'), text('still looking'), text('the answer')]
    const hidden = interimTextParts([a, tool, b, tool, c], false)
    expect([...hidden]).toEqual([a, b])
    expect(hidden.has(c)).toBe(false)
  })

  it('hides all of it while the turn is running', () => {
    const [a, b] = [text('looking'), text('the answer so far')]
    expect(interimTextParts([a, tool, b], true).size).toBe(2)
  })

  it('ignores blank text and keeps a lone answer', () => {
    const answer = text('done')
    expect(interimTextParts([text('  '), answer], false).size).toBe(0)
    expect(interimTextParts([], false).size).toBe(0)
  })

  it('a steer starts a new message, so the reply before it keeps its own last text', () => {
    // Two assistant messages with the steer between them: each is judged alone.
    const before = [text('checking'), tool, text('found the file')]
    const after = [text('on it'), tool, text('renamed it')]
    expect(interimTextParts(before, false).size).toBe(1)
    expect(interimTextParts(before, false).has(before[2])).toBe(false)
    expect(interimTextParts(after, false).has(after[2])).toBe(false)
  })
})

describe('stored transcript view', () => {
  const rehydrate = (stored: unknown) => {
    const state = { transcriptView: stored } as Record<string, unknown>
    interfacePersistOptions.onRehydrateStorage?.(state as never)?.(state as never)
    return state.transcriptView
  }

  it.each(['zen', 'quiet', 'normal', 'thinking', 'verbose'])(
    'keeps a stored %s',
    (view) => expect(rehydrate(view)).toBe(view)
  )

  it('falls back to the default for an unknown value', () => {
    expect(rehydrate('hush')).toBe(DEFAULT_TRANSCRIPT_VIEW)
    expect(rehydrate(undefined)).toBe(DEFAULT_TRANSCRIPT_VIEW)
  })
})
