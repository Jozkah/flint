import { describe, it, expect, beforeEach } from 'vitest'
import type { UIMessage } from 'ai'
import {
  attachToolScreenshots,
  forgetToolScreenshots,
  getToolScreenshot,
  MAX_KEPT_SCREENSHOTS,
  MAX_SCREENSHOT_CHARS,
  putToolScreenshot,
  SCREENSHOT_TOKEN_ESTIMATE,
  screenshotsToAttach,
} from '../toolScreenshots'
import { clearStaleToolResults } from '../context-manager'

const jpeg = (n = 1) => `data:image/jpeg;base64,${'A'.repeat(n)}`

const browserResult = (id: string, output = 'Screenshot of x.') =>
  ({
    type: 'tool-browser',
    toolCallId: id,
    state: 'output-available',
    input: { action: 'screenshot' },
    output,
  }) as never

const assistant = (id: string, ...parts: unknown[]) =>
  ({ id, role: 'assistant', parts }) as unknown as UIMessage

const user = (id: string, text: string) =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage

describe('toolScreenshots', () => {
  beforeEach(() => forgetToolScreenshots())

  it('keeps only bounded image data URLs', () => {
    expect(putToolScreenshot('c1', jpeg())).toBe(true)
    expect(getToolScreenshot('c1')).toBe(jpeg())
    expect(putToolScreenshot('c2', 'https://example.com/x.png')).toBe(false)
    expect(putToolScreenshot('c3', 'data:text/html;base64,AAAA')).toBe(false)
    expect(putToolScreenshot('c4', jpeg(MAX_SCREENSHOT_CHARS))).toBe(false)
    expect(putToolScreenshot('', jpeg())).toBe(false)
  })

  it('forgets the oldest picture past its limit', () => {
    for (let i = 0; i < MAX_KEPT_SCREENSHOTS * 2 + 2; i++) {
      putToolScreenshot(`c${i}`, jpeg())
    }
    expect(getToolScreenshot('c0')).toBeUndefined()
    expect(getToolScreenshot(`c${MAX_KEPT_SCREENSHOTS * 2 + 1}`)).toBeDefined()
  })

  it('leaves a model that cannot see exactly as it was', () => {
    putToolScreenshot('c1', jpeg())
    const messages = [user('u1', 'go'), assistant('a1', browserResult('c1'))]
    expect(attachToolScreenshots(messages, { supportsVision: false })).toBe(messages)
    expect(screenshotsToAttach(messages)).toBe(1)
  })

  it('attaches the picture for a model that can see, without touching the stored messages', () => {
    putToolScreenshot('c1', jpeg(8))
    const messages = [user('u1', 'go'), assistant('a1', browserResult('c1'))]
    const before = JSON.stringify(messages)
    const out = attachToolScreenshots(messages, { supportsVision: true })
    expect(JSON.stringify(messages)).toBe(before)
    expect(out).toHaveLength(3)
    expect(out[2].role).toBe('user')
    const file = out[2].parts.find((p) => p.type === 'file') as unknown as {
      url: string
      mediaType: string
    }
    expect(file.url).toBe(jpeg(8))
    expect(file.mediaType).toBe('image/jpeg')
  })

  it('attaches only the newest few, and never one whose result was cleared', () => {
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5']
    ids.forEach((id) => putToolScreenshot(id, jpeg()))
    const messages = [
      user('u1', 'go'),
      ...ids.map((id) => assistant(`a-${id}`, browserResult(id))),
    ]
    expect(screenshotsToAttach(messages)).toBe(MAX_KEPT_SCREENSHOTS)
    const withCleared = messages.map((m, i) =>
      i === messages.length - 1
        ? assistant('a-last', browserResult('c5', '[tool result cleared: browser 3k chars]'))
        : m
    )
    expect(screenshotsToAttach(withCleared)).toBe(MAX_KEPT_SCREENSHOTS)
    const out = attachToolScreenshots(withCleared, { supportsVision: true })
    const files = out.flatMap((m) => m.parts.filter((p) => p.type === 'file'))
    expect(files).toHaveLength(MAX_KEPT_SCREENSHOTS)
  })

  it('ignores results of other tools and unfinished calls', () => {
    putToolScreenshot('c1', jpeg())
    putToolScreenshot('c2', jpeg())
    const messages = [
      user('u1', 'go'),
      assistant('a1', { type: 'tool-read', toolCallId: 'c1', state: 'output-available', output: 'x' }),
      assistant('a2', { type: 'tool-browser', toolCallId: 'c2', state: 'input-available', input: {} }),
    ]
    expect(screenshotsToAttach(messages)).toBe(0)
    expect(attachToolScreenshots(messages, { supportsVision: true })).toBe(messages)
  })

  it('works with a dynamic tool part', () => {
    putToolScreenshot('c1', jpeg())
    const messages = [
      assistant('a1', {
        type: 'dynamic-tool',
        toolName: 'browser',
        toolCallId: 'c1',
        state: 'output-available',
        output: 'Screenshot of x.',
      }),
    ]
    expect(screenshotsToAttach(messages)).toBe(1)
  })

  it('costs a bounded, sane amount of context', () => {
    expect(SCREENSHOT_TOKEN_ESTIMATE).toBeGreaterThan(500)
    expect(SCREENSHOT_TOKEN_ESTIMATE * MAX_KEPT_SCREENSHOTS).toBeLessThan(8000)
  })

  it('does not change what microcompaction clears or counts: the stored result is text', () => {
    const long = 'x'.repeat(2000)
    const messages = [
      user('u1', 'one'),
      assistant('a1', browserResult('c1', long)),
      user('u2', 'two'),
      assistant('a2', browserResult('c2', long)),
      user('u3', 'three'),
      assistant('a3', browserResult('c3', long)),
    ]
    const { messages: cleared, clearedCount } = clearStaleToolResults(messages, {
      keepRecentResults: 1,
      protectedTurns: 1,
      minChars: 400,
    })
    expect(clearedCount).toBe(2)
    putToolScreenshot('c1', jpeg())
    putToolScreenshot('c3', jpeg())
    // The cleared result's picture is no longer attached; the newest still is.
    expect(screenshotsToAttach(cleared)).toBe(1)
  })
})
