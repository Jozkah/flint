import { describe, it, expect } from 'vitest'
import { isNeedsHelp, needsHelpFrom, NEEDS_HELP_PREFIX } from '../campaignHelp'

describe('needs help', () => {
  it('reads a stopped test run as help wanted, with the shell and a hint', () => {
    const help = needsHelpFrom(
      'Bash hit the same non-transient blocker twice (test runner cannot start in the sandbox) ' +
        '(shell: powershell, PowerShell syntax). Run it with `node --test --test-isolation=none`.'
    )
    expect(help?.detail.startsWith(NEEDS_HELP_PREFIX)).toBe(true)
    expect(help?.detail).toContain('powershell, PowerShell syntax')
    expect(help?.hint).toContain('--test-isolation=none')
  })

  it('leaves an ordinary failure alone', () => {
    expect(needsHelpFrom('model fell over')).toBeNull()
    expect(needsHelpFrom(undefined)).toBeNull()
  })

  it('knows a task that is waiting for help', () => {
    expect(isNeedsHelp({ status: 'failed', detail: 'needs help: x' })).toBe(true)
    expect(isNeedsHelp({ status: 'running', detail: 'needs help: x' })).toBe(false)
    expect(isNeedsHelp({ status: 'failed', detail: 'boom' })).toBe(false)
  })
})
