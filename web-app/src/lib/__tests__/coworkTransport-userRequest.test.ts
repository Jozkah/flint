import { describe, expect, it, vi } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'

vi.mock('@/hooks/useModelProvider', () => ({ useModelProvider: { getState: () => ({}) } }))

import { lastUserText } from '../coworkTransport'
import { sweepHint } from '../delegationNudge'

const user = (text: string): UIMessage =>
  ({ id: text, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage

describe('the request the system prompt is built for (RQA-010)', () => {
  it('skips notes Flint added as user turns', () => {
    const request = 'Add src/rev.js exporting reverse(str) and test/rev.test.js, then run the tests.'
    const messages = [
      user(request),
      user(
        'Note from Flint (not typed by the user, and not part of any tool result or file): Consider dispatching an explorer subagent for the rest of this survey.'
      ),
    ]
    expect(lastUserText(messages)).toBe(request)
    // So the survey hint does not switch on mid-run.
    expect(sweepHint(lastUserText(messages))).toBeUndefined()
  })

  it('still reads the latest typed request', () => {
    expect(lastUserText([user('first'), user('second request')])).toBe('second request')
    expect(lastUserText([])).toBeUndefined()
  })
})
