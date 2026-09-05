import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CodeOpenContext } from '@/lib/codeOpen'
import { RenderMarkdown } from '@/containers/RenderMarkdown'

// End-to-end proof that an explicit @path reference survives the markdown
// pipeline (remark plugin → rehype sanitize → component override) and becomes a
// clickable opener in a Cowork context — and that ordinary markdown around it
// is preserved.
describe('RenderMarkdown file references', () => {
  it('linkifies an explicit @path and opens it, preserving other markdown', async () => {
    const open = vi.fn()
    render(
      <CodeOpenContext.Provider value={open}>
        <RenderMarkdown
          messageId="m1"
          content={'See @src/example.ts:12 for the **fix**.'}
        />
      </CodeOpenContext.Provider>
    )
    const btn = await screen.findByRole('button', { name: '@src/example.ts:12' })
    // Ordinary prose around the reference is preserved.
    expect(screen.getByText(/See/)).toBeInTheDocument()
    await userEvent.click(btn)
    expect(open).toHaveBeenCalledWith('src/example.ts')
  })

  it('leaves an @path inert (plain text) with no opener, and never links a URL', async () => {
    render(
      <RenderMarkdown
        messageId="m2"
        content={'plain @src/a.ts and a link https://example.com/u@h/x.ts'}
      />
    )
    // The reference text is present but not a button (no code panel in chat).
    expect(await screen.findByText(/plain/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /@src\/a\.ts/ })).toBeNull()
  })
})
