import { describe, expect, it } from 'vitest'
import {
  classifyStableFailure,
  detectLoop,
  type ObservedCall,
} from '../runLoopGuard'

const missingRead = (path: string, limit: number): ObservedCall => ({
  tool: 'read',
  input: { path, offset: 1, limit },
  failed: true,
  error: 'ERROR: path specified was not found',
})

const outsideRead = (path: string, limit: number): ObservedCall => ({
  tool: 'read',
  input: { path, offset: 1, limit },
  failed: true,
  error:
    "tool 'read' was refused: that path is outside the workspace and every " +
    'folder the user has granted. Call request_access with the narrowest ' +
    'required path and explain why access is needed, then retry this call.',
})

describe('resource-scoped blockers', () => {
  it('recognises an outside-path refusal as requiring access to change', () => {
    expect(classifyStableFailure('read', outsideRead('C:/private/a.ts', 10).error)).toBe(
      'access must change before retrying'
    )
  })

  it('stops cosmetic retries against the same denied path', () => {
    expect(
      detectLoop([
        outsideRead('C:/private/a.ts', 10),
        outsideRead('C:/private/a.ts', 200),
      ])
    ).toMatchObject({ tripped: true, reason: 'failing-tool' })
  })

  it('allows trying a genuinely different path after an access refusal', () => {
    expect(
      detectLoop([
        outsideRead('C:/private/a.ts', 10),
        outsideRead('D:/shared/b.ts', 10),
      ])
    ).toEqual({ tripped: false })
  })

  it('does not treat different missing paths as one repeated failure', () => {
    expect(
      detectLoop([
        missingRead('node_modules/.bin/vitest.cmd', 20),
        missingRead('web-app/node_modules/.bin/vitest.cmd', 20),
        missingRead('../node_modules/.bin/vitest.cmd', 20),
      ])
    ).toEqual({ tripped: false })
  })

  it('does stop the same missing path retried with cosmetic read changes', () => {
    expect(
      detectLoop([
        missingRead('node_modules/.bin/vitest.cmd', 10),
        missingRead('node_modules/.bin/vitest.cmd', 20),
        missingRead('node_modules/.bin/vitest.cmd', 200),
      ])
    ).toMatchObject({ tripped: true, reason: 'repeated-failure' })
  })
})
