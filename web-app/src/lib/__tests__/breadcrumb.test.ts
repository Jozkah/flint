import { describe, expect, it } from 'vitest'
import { crumbForPath } from '../breadcrumb'
import { statusFor, updatedMs } from '@/containers/ThreadStatusMark'

describe('crumbForPath', () => {
  it.each([
    ['/', 'common:appRail.workspace', 'common:newChat'],
    ['/artifacts', 'common:appRail.workspace', 'common:appRail.library'],
    ['/settings/providers', 'common:shell.engine', 'common:appRail.models'],
    ['/settings/mcp-servers', 'common:shell.engine', 'common:shell.toolsAndMcp'],
    ['/system-monitor', 'common:shell.engine', 'common:shell.systemMonitor'],
    ['/logs', 'common:shell.support', 'common:shell.logs'],
    ['/settings/interface', 'common:settings', 'common:appearance'],
  ])('%s is %s / %s', (path, parent, current) => {
    const c = crumbForPath(path)
    expect(c.parentKey).toBe(parent)
    expect(c.currentKey).toBe(current)
  })

  it('names threads, rooms and providers from the page', () => {
    expect(crumbForPath('/threads/t1')).toMatchObject({ dynamic: 'thread', param: 't1', currentKey: null })
    expect(crumbForPath('/cowork')).toMatchObject({ dynamic: 'session', parentKey: 'common:cowork' })
    expect(crumbForPath('/rooms/r1')).toMatchObject({ dynamic: 'room', parentKey: 'common:appRail.rooms' })
    expect(crumbForPath('/settings/providers/llama.cpp')).toMatchObject({ dynamic: 'provider', param: 'llama.cpp' })
  })
})

describe('thread status', () => {
  const now = 1_800_000_000_000
  it('is active while working and waiting when the user owes an answer', () => {
    expect(statusFor({ updated: 0 }, true, now)).toBe('active')
    expect(statusFor({ updated: 0 }, true, now, true)).toBe('wait')
  })
  it('is recent for an hour, then nothing', () => {
    expect(statusFor({ updated: now - 30 * 60_000 }, false, now)).toBe('recent')
    expect(statusFor({ updated: now - 2 * 60 * 60_000 }, false, now)).toBe('none')
  })
  it('reads second and millisecond timestamps', () => {
    expect(updatedMs(1_700_000_000)).toBe(1_700_000_000_000)
    expect(updatedMs(1_700_000_000_000)).toBe(1_700_000_000_000)
  })
})
