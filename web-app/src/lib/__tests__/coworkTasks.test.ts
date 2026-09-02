import { describe, it, expect } from 'vitest'
import {
  backgroundJobId,
  collectedJobId,
  commandOf,
  countToolCalls,
} from '@/lib/coworkTasks'
import type { CoworkTurn } from '@/types/coworkSession'

describe('backgroundJobId', () => {
  it('reads the id out of the sentence the bash tool actually prints', () => {
    expect(
      backgroundJobId(
        'Command exceeded 120s and is continuing in the background ' +
          '(job_id=bash-3). Call bash again with {"job_id": "bash-3"} (no ' +
          'command) to wait for and collect its output once it finishes.'
      )
    ).toBe('bash-3')
  })

  it('finds nothing in ordinary output', () => {
    expect(backgroundJobId('build succeeded in 4.2s')).toBeNull()
  })

  it('finds nothing in a value that is not text', () => {
    // Tool results arrive untyped; a structured result must not throw here.
    expect(backgroundJobId(undefined)).toBeNull()
    expect(backgroundJobId({ job_id: 'bash-1' })).toBeNull()
  })
})

describe('countToolCalls', () => {
  const turn = (role: CoworkTurn['role']): CoworkTurn => ({ role, content: '' })

  it('counts the tool turns and nothing else', () => {
    expect(
      countToolCalls([turn('user'), turn('tool'), turn('assistant'), turn('tool')])
    ).toBe(2)
  })

  it('counts nothing in an absent transcript', () => {
    expect(countToolCalls(undefined)).toBe(0)
  })
})

describe('reading a bash call’s arguments', () => {
  it('takes the command line when it has finished streaming', () => {
    expect(commandOf({ command: 'pnpm build' })).toBe('pnpm build')
  })

  it('takes nothing while the arguments are still partial', () => {
    // A call whose arguments have not parsed yet carries no command; the
    // partial JSON is not one.
    expect(commandOf(undefined)).toBeUndefined()
    expect(commandOf({})).toBeUndefined()
    expect(commandOf({ command: 42 })).toBeUndefined()
  })

  it('recognises the call that collects a backgrounded command', () => {
    expect(collectedJobId({ job_id: 'bash-3' })).toBe('bash-3')
  })

  it('does not mistake a plain command for a collection', () => {
    expect(collectedJobId({ command: 'ls' })).toBeUndefined()
    expect(collectedJobId({ job_id: '' })).toBeUndefined()
  })
})
