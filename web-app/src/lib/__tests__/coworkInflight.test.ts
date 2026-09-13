import { describe, it, expect } from 'vitest'
import type { UIMessage } from 'ai'
import type { CoworkTurn } from '@/types/coworkSession'
import {
  CHECKPOINT_EVERY_MS,
  RECOVERY_NOTE_PREFIX,
  checkpoint,
  checkpointDue,
  isInterrupted,
  recover,
  unfinishedReply,
} from '@/lib/coworkInflight'

const base: UIMessage[] = [
  { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'earlier question' }] } as UIMessage,
  { id: 'a0', role: 'assistant', parts: [{ type: 'text', text: 'earlier answer' }] } as UIMessage,
]

const liveTurns = (): CoworkTurn[] => [
  { role: 'user', content: 'fix the readme' },
  { role: 'tool', content: '', callId: 'c1', name: 'read', status: 'done', args: { path: 'README.md' }, result: '# Title' } as CoworkTurn,
  { role: 'tool', content: '', callId: 'c2', name: 'bash', status: 'running', args: { command: 'npm test' } } as CoworkTurn,
  { role: 'assistant', content: 'I read the file and will now ' },
]

const textOf = (m: UIMessage) =>
  (m.parts as any[]).filter((p) => p.type === 'text').map((p) => p.text).join('')

describe('coworkInflight (AH-026)', () => {
  it('checkpoints at every step and at most every half second while text streams', () => {
    expect(checkpointDue(undefined, 1000, false)).toBe(true)
    expect(checkpointDue(1000, 1000 + CHECKPOINT_EVERY_MS - 1, false)).toBe(false)
    expect(checkpointDue(1000, 1000 + CHECKPOINT_EVERY_MS, false)).toBe(true)
    expect(checkpointDue(1000, 1001, true)).toBe(true)
  })

  it('keeps a copy of the turns, not the run’s live array', () => {
    const turns = liveTurns()
    const record = checkpoint('run-1', 1, base.length, turns, 5)
    ;(turns[3] as any).content += 'more'
    expect(unfinishedReply(record)).toBe('I read the file and will now ')
  })

  it('is interrupted only when its run is not the one running here', () => {
    const record = checkpoint('run-1', 1, 2, liveTurns(), 5)
    expect(isInterrupted(record, 'run-1')).toBe(false)
    expect(isInterrupted(record, undefined)).toBe(true)
    expect(isInterrupted(record, 'run-2')).toBe(true)
    expect(isInterrupted(undefined, undefined)).toBe(false)
    expect(isInterrupted(checkpoint('run-1', 1, 2, [], 5), undefined)).toBe(false)
  })

  it('continues with the completed calls, the unfinished reply and a note from Jan', () => {
    const record = checkpoint('run-1', 1, base.length, liveTurns(), 5)
    const { turns, messages } = recover(base, record, 'continue', 's1')
    expect(turns[1]).toMatchObject({ callId: 'c1', status: 'done', result: '# Title' })
    // A call that never finished is closed, not left running.
    expect(turns[2]).toMatchObject({ callId: 'c2', status: 'done', toolState: 'stale', isError: true })
    expect(turns[3]).toMatchObject({ role: 'assistant', content: 'I read the file and will now ' })
    const note = turns[turns.length - 1]
    expect(note.role).toBe('user')
    expect(note.content.startsWith(RECOVERY_NOTE_PREFIX)).toBe(true)
    expect(note.content).toContain('may be incomplete')

    expect(messages.slice(0, 2)).toEqual(base)
    const last = messages[messages.length - 1]
    expect(last.role).toBe('user')
    expect(textOf(last)).toContain('may be incomplete')
    const toolParts = messages.flatMap((m) => (m.parts as any[]).filter((p) => String(p.type).startsWith('tool-')))
    expect(toolParts.map((p) => p.toolCallId)).toEqual(['c1', 'c2'])
  })

  it('discards the unfinished reply but never a completed call', () => {
    const record = checkpoint('run-1', 1, base.length, liveTurns(), 5)
    const { turns, messages } = recover(base, record, 'discard-partial', 's1')
    expect(turns.some((t) => t.role === 'assistant' && t.content.startsWith('I read the file'))).toBe(false)
    expect(turns.some((t) => t.callId === 'c1' && t.result === '# Title')).toBe(true)
    expect(turns[turns.length - 1].content).toContain('discarded')
    expect(messages.some((m) => textOf(m).includes('I read the file and will now'))).toBe(false)
  })

  it('closes a call left waiting for approval, and leaves a finished one alone', () => {
    const turns: CoworkTurn[] = [
      { role: 'tool', content: '', callId: 'w1', name: 'write', toolState: 'awaiting-permission' } as CoworkTurn,
      { role: 'tool', content: '', callId: 'r1', name: 'read', toolState: 'succeeded', status: 'done', result: 'ok' } as CoworkTurn,
    ]
    const { turns: out } = recover(base, checkpoint('run-2', 1, 2, turns, 5), 'continue', 's1')
    expect(out[0]).toMatchObject({ toolState: 'stale', isError: true })
    expect(out[1]).toMatchObject({ toolState: 'succeeded', result: 'ok' })
    expect(out[1].isError).toBeUndefined()
  })

  it('says plainly when there was no unfinished reply', () => {
    const turns = liveTurns().slice(0, 2)
    const record = checkpoint('run-1', 1, base.length, turns, 5)
    const { turns: out } = recover(base, record, 'continue', 's1')
    expect(out[out.length - 1].content).toContain('every completed step above is kept')
    expect(out.filter((t) => t.role === 'assistant')).toHaveLength(0)
  })
})
