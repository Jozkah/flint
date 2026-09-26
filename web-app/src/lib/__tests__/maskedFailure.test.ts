import { describe, expect, it } from 'vitest'
import { maskedFailure } from '../coworkRunner'
import { bashExitCode } from '../redact'

// The shell tool's result for a PowerShell chain whose native step failed
// while the chain reported 0: the marker carries the real code, and the note
// still names the masking.
const masked =
  'go: vet failed\nEXIT=2\n[exit 2]\n[shell: reported exit 0, but a command inside it exited with 2. The result carries exit 2. Treat this command as failed.]'

describe('masked shell failure', () => {
  it('is detected from the note', () => {
    expect(maskedFailure(masked)).toBe(true)
    expect(maskedFailure('ok\n[exit 0]')).toBe(false)
    expect(maskedFailure(undefined)).toBe(false)
  })

  it('reports the failing command exit code, not 0', () => {
    expect(bashExitCode(masked)).toBe(2)
  })
})
