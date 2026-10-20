import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shouldKeepAwake, startKeepAwakeSync } from '../keepAwake'
import { useCoworkActiveWork } from '@/hooks/useCoworkActiveWork'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const authority = { folder: null, access: 'read' as never, destination: 'project' as never }

describe('keep awake', () => {
  beforeEach(() => {
    useCoworkActiveWork.setState({ items: {} })
    useGeneralSetting.setState({ keepAwakeDuringRuns: true })
  })

  it('wants awake only for a live run with the setting on', () => {
    expect(shouldKeepAwake(true, {})).toBe(false)
    expect(shouldKeepAwake(true, { a: { kind: 'shell' } })).toBe(false)
    expect(shouldKeepAwake(true, { a: { kind: 'run' } })).toBe(true)
    expect(shouldKeepAwake(false, { a: { kind: 'run' } })).toBe(false)
  })

  it('sends only changes and releases when the run ends', () => {
    const send = vi.fn().mockResolvedValue(true)
    const stop = startKeepAwakeSync(send)
    expect(send).not.toHaveBeenCalled()
    const release = useCoworkActiveWork
      .getState()
      .acquire({ sessionId: 's', kind: 'run', authority })
    expect(send).toHaveBeenLastCalledWith(true)
    release()
    expect(send).toHaveBeenLastCalledWith(false)
    expect(send).toHaveBeenCalledTimes(2)
    useGeneralSetting.getState().setKeepAwakeDuringRuns(false)
    expect(send).toHaveBeenCalledTimes(2)
    stop()
  })
})
