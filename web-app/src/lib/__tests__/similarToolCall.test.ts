import { describe, expect, it } from 'vitest'
import { similarToolCall } from '../similarToolCall'

describe('similarToolCall', () => {
  it('recognizes clipboard reads but never clipboard writes', () => {
    expect(similarToolCall('clipboard', { action: 'read' })?.key).toBe('clipboard:read')
    expect(similarToolCall('clipboard', { action: 'write', text: 'x' })).toBeNull()
  })
  it('groups single-process kills across different IDs', () => {
    expect(similarToolCall('host_powershell', { script: 'Stop-Process -Id 42' })?.key)
      .toBe(similarToolCall('host_powershell', { script: 'stop-process -id 99' })?.key)
    expect(similarToolCall('host_action', { action: 'kill_process', pid: 42 })?.key)
      .toBe(similarToolCall('host_action', { action: 'kill_process', pid: 99 })?.key)
  })

  it('keeps Force distinct and rejects compound or unrecognized scripts', () => {
    expect(similarToolCall('host_powershell', { script: 'Stop-Process -Id 42 -Force' })?.key)
      .not.toBe(similarToolCall('host_powershell', { script: 'Stop-Process -Id 42' })?.key)
    for (const script of [
      'Stop-Process -Id 42; Remove-Item C:\\data',
      'Stop-Process -Id 42,43',
      'Get-Process foo | Stop-Process',
      'Stop-Process -Id $pid',
    ]) expect(similarToolCall('host_powershell', { script })).toBeNull()
    expect(similarToolCall('host_action', { action: 'kill_process', pid: 42, force: true }))
      .toBeNull()
  })
})
