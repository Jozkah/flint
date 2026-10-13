import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RichComposerEditor } from '../RichComposerEditor'

describe('RichComposerEditor', () => {
  it('renders Markdown as inline formatting and sends Markdown', async () => {
    const onSend = vi.fn()
    render(
      <RichComposerEditor
        value="**Bold** and `code`"
        onChange={vi.fn()}
        onSend={onSend}
        onPaste={vi.fn()}
        placeholder="Message"
      />
    )
    const input = await screen.findByRole('textbox', { name: 'Message' })
    expect(input.querySelector('strong')?.textContent).toBe('Bold')
    expect(input.querySelector('code')?.textContent).toBe('code')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('**Bold** and `code`', false))
  })

  it('formats quote and code block without sending on Enter inside code', async () => {
    const onSend = vi.fn()
    render(
      <RichComposerEditor
        value={' > quote\n\n```js\nconst x = 1\n```'}
        onChange={vi.fn()}
        onSend={onSend}
        onPaste={vi.fn()}
        placeholder="Message"
      />
    )
    const input = await screen.findByRole('textbox', { name: 'Message' })
    expect(input.querySelector('blockquote')?.textContent).toContain('quote')
    expect(input.querySelector('pre code')?.textContent).toContain('const x = 1')
    const code = input.querySelector('pre code')!
    fireEvent.click(code)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('leaves plain Enter to the editor when Enter adds a new line, still sends on Ctrl+Enter', async () => {
    const onSend = vi.fn()
    render(
      <RichComposerEditor
        value="hello"
        onChange={vi.fn()}
        onSend={onSend}
        onPaste={vi.fn()}
        enterInsertsNewline
        placeholder="Message"
      />
    )
    const input = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(expect.stringContaining('hello'), true))
  })

  it('passes an empty draft to composer send handler for attachment-only messages', async () => {
    const onSend = vi.fn()
    render(
      <RichComposerEditor
        value=""
        onChange={vi.fn()}
        onSend={onSend}
        onPaste={vi.fn()}
        placeholder="Message"
      />
    )
    fireEvent.keyDown(await screen.findByRole('textbox', { name: 'Message' }), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('', false)
  })
})
