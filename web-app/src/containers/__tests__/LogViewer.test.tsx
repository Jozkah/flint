import { describe, it, expect } from 'vitest'
import { displayLogMessage } from '../LogViewer'

describe('displayLogMessage', () => {
  it('drops the console forwarder call site', () => {
    expect(
      displayLogMessage(
        'forward@http://localhost:1420/src/services/app/console-logger.ts:22:10: Registered remote provider: openai'
      )
    ).toBe('Registered remote provider: openai')
  })

  it('leaves an ordinary message alone', () => {
    expect(displayLogMessage('settings: flushed 1 key(s) to disk')).toBe(
      'settings: flushed 1 key(s) to disk'
    )
  })
})
