import { act, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { RichComposerEditor } from '../RichComposerEditor'

// A controlled composer, as ChatInput drives it: the typed Markdown goes to a
// store and comes back down as `value`.
function Controlled({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <RichComposerEditor
      value={value}
      onChange={setValue}
      onSend={vi.fn()}
      onPaste={vi.fn()}
      placeholder="Message"
    />
  )
}

async function mount(initial: string) {
  render(<Controlled initial={initial} />)
  const input = await screen.findByRole('textbox', { name: 'common:composer.messageLabel' })
  return (input as unknown as { editor: Editor }).editor
}

describe('RichComposerEditor per-keystroke cost', () => {
  it('serializes the document once and applies one transaction per typed character', async () => {
    const editor = await mount('a draft that is already a few lines long\n\nsecond paragraph')
    editor.commands.focus('end')
    const serialize = vi.spyOn(editor, 'getMarkdown')
    const transactions = vi.fn()
    editor.on('transaction', transactions)
    const keys = 20
    for (let i = 0; i < keys; i++) {
      await act(async () => {
        editor.commands.insertContent('x')
      })
    }
    // Before the fix, 20 keys cost 40 getMarkdown calls and 42 transactions. The extra
    // transaction was the mention-label refresh, which rebuilt the decorations
    // over the whole document although no label had changed.
    expect(serialize.mock.calls.length).toBe(keys)
    // (+2: the editor's own selection/focus transactions around the first keys)
    expect(transactions.mock.calls.length).toBeLessThanOrEqual(keys + 2)
  })

  it('still refreshes pill labels when a mention appears', async () => {
    const editor = await mount('')
    editor.commands.focus('end')
    await act(async () => {
      editor.commands.insertContent('@chat:abc-123 ')
    })
    expect(editor.view.dom.querySelector('[data-testid="mention-pill"]')).not.toBeNull()
  })
})
