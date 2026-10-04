import { describe, expect, it } from 'vitest'
import { HOST_ASKED, hostCallNeedsAsking, hostCallOptions } from '../hostAsked'

describe('host tool questions', () => {
  it('carries the call id for every host tool, so the question sits under its card', () => {
    for (const tool of HOST_ASKED) {
      expect(hostCallOptions(tool, 'call-1')).toEqual({ callId: 'call-1' })
    }
    expect(hostCallOptions('host_powershell', 'abc')).toEqual({ callId: 'abc' })
  })

  it('leaves every other tool alone', () => {
    for (const tool of ['read', 'write', 'bash', 'web_fetch', 'host_query', 'docker', 'windows_events']) {
      expect(hostCallOptions(tool, 'call-1')).toEqual({})
    }
  })

  it('asks about winget only when it changes a program', () => {
    expect(hostCallNeedsAsking('host_package', { action: 'list' })).toBe(false)
    expect(hostCallNeedsAsking('host_package', { action: 'outdated' })).toBe(false)
    expect(hostCallNeedsAsking('host_package', { action: 'install', id: 'Git.Git' })).toBe(true)
    expect(hostCallNeedsAsking('host_package', null)).toBe(false)
    expect(hostCallNeedsAsking('host_powershell', { script: 'Get-Date' })).toBe(true)
  })
})
