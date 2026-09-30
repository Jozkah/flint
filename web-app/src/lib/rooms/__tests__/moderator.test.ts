import { describe, expect, it } from 'vitest'
import { parseDirective } from '../moderator'

describe('parseDirective with Windows paths', () => {
  it('keeps a path written with single backslashes instead of rejecting the directive', () => {
    const bs = String.fromCharCode(92)
    const path = `C:${bs}tmp${bs}room-test${bs}app`
    const raw = `{"next": "Nina", "request": "Run the tests in ${path} now", "converged": false, "stop": false, "reason": "x"}`
    const d = parseDirective(raw)
    expect(d?.next).toBe('Nina')
    expect(d?.request).toContain(path)
  })
})
