/** #321: a resumed tool call always carries arguments. */
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { coworkTurnsToUIMessages, withToolInputs } from '../coworkTurns'
import { recover } from '../coworkInflight'
import { sessionWorktreeBranch } from '../coworkWorktrees'

describe('#321 tool arguments on resume', () => {
  it('replays a call saved without arguments with an empty object', () => {
    const messages = coworkTurnsToUIMessages([
      { role: 'user', content: 'go' },
      { role: 'tool', content: '', callId: 'c1', name: 'ls', status: 'running' },
    ]) as any[]
    const part = messages
      .flatMap((m) => m.parts)
      .find((p: any) => p.type === 'tool-ls')
    expect(part.input).toEqual({})
  })

  it('recovery keeps saved arguments and defaults missing ones', () => {
    const { turns, messages } = recover(
      [],
      {
        runId: 'run-1',
        startedAt: 0,
        checkpointAt: 1,
        baseCount: 0,
        turns: [
          { role: 'user', content: 'go' },
          {
            role: 'tool',
            content: '',
            callId: 'a',
            name: 'bash',
            args: { command: 'dir' },
            status: 'done',
            result: 'ok',
          },
          { role: 'tool', content: '', callId: 'b', name: 'bash', status: 'running' },
        ],
      },
      'continue',
      's1'
    )
    expect(turns[1].args).toEqual({ command: 'dir' })
    expect(turns[2].args).toEqual({})
    const inputs = (messages as any[])
      .flatMap((m) => m.parts)
      .filter((p: any) => p.type === 'tool-bash')
      .map((p: any) => p.input)
    expect(inputs).toEqual([{ command: 'dir' }, {}])
  })

  it('fills a missing input on any tool part sent to the provider', () => {
    const msg = {
      id: 'm',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'hi' },
        { type: 'tool-read', toolCallId: 'x', state: 'output-available', output: 'ok' },
        {
          type: 'tool-ls',
          toolCallId: 'y',
          input: { path: '.' },
          state: 'output-available',
          output: 'ok',
        },
      ],
    } as unknown as UIMessage
    const untouched = {
      id: 'u',
      role: 'user',
      parts: [{ type: 'text', text: 'q' }],
    } as UIMessage
    const [out, same] = withToolInputs([msg, untouched])
    expect((out.parts[1] as any).input).toEqual({})
    expect((out.parts[2] as any).input).toEqual({ path: '.' })
    expect(same).toBe(untouched)
  })
})

describe('a session knows its own worktree', () => {
  it('derives the branch the backend gives a session', () => {
    const branch = sessionWorktreeBranch('session-1')
    expect(branch).toMatch(/^jan\/cowork\/session1-[0-9a-f]{16}$/)
    expect(sessionWorktreeBranch('session-1')).toBe(branch)
    expect(sessionWorktreeBranch('session-2')).not.toBe(branch)
    expect(sessionWorktreeBranch('')).toMatch(/^jan\/cowork\/session-/)
  })
})
