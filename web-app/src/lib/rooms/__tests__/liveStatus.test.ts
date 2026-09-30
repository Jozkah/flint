import { describe, expect, it } from 'vitest'
import { liveStatus } from '../liveStatus'
import type { LiveTurn } from '../types'

const base = { roomId: 'r', author: { kind: 'participant', id: 'a' }, text: '' } as unknown as LiveTurn

describe('liveStatus', () => {
  it('is thinking before anything arrives', () => {
    expect(liveStatus(base, null)).toEqual({ kind: 'thinking' })
  })
  it('is writing once text streams', () => {
    expect(liveStatus({ ...base, text: 'Hi' }, null)).toEqual({ kind: 'writing' })
  })
  it('names the running tool', () => {
    const s = liveStatus({ ...base, activity: { name: 'bash', args: { command: 'ls' } } }, null)
    expect(s.kind).toBe('tool')
  })
  it('waiting for approval wins over a running tool', () => {
    const s = liveStatus({ ...base, activity: { name: 'bash' } }, 'bash')
    expect(s).toEqual({ kind: 'approval', tool: 'bash' })
  })
  it('compacting wins over everything', () => {
    expect(liveStatus({ ...base, compacting: true }, 'bash')).toEqual({ kind: 'compacting' })
  })
})
