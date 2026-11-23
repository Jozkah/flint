import { describe, it, expect } from 'vitest'
import { mcpFailureText } from '../mcpToolResult'

describe('mcpFailureText', () => {
  it('is undefined for a result that did not fail', () => {
    expect(mcpFailureText({ content: [{ type: 'text', text: 'ok' }] })).toBeUndefined()
    expect(mcpFailureText({ isError: false, content: 'ok' })).toBeUndefined()
  })

  it('uses the error field when there is one', () => {
    expect(mcpFailureText({ error: 'boom', content: 'x' })).toBe('boom')
  })

  it('reads the text blocks of an isError result', () => {
    expect(
      mcpFailureText({
        isError: true,
        content: [
          { type: 'text', text: 'file not found' },
          { type: 'image', data: '..' },
          { type: 'text', text: 'path: /x' },
        ],
      })
    ).toBe('file not found\npath: /x')
    expect(mcpFailureText({ isError: true, content: ' denied ' })).toBe('denied')
  })

  it('still says something when the failure carries no text', () => {
    expect(mcpFailureText({ isError: true })).toBe('The tool reported an error with no message.')
    expect(mcpFailureText({ isError: true, content: [{ type: 'image' }] })).toBe(
      JSON.stringify([{ type: 'image' }])
    )
  })
})
