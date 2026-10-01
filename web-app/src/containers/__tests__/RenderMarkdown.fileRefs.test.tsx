import { describe, it, expect, vi } from 'vitest'

const opener = vi.hoisted(() => ({
  openPath: vi.fn(async () => {}),
  revealItemInDir: vi.fn(async () => {}),
}))
vi.mock('@/hooks/useServiceHub', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useServiceHub')>()),
  getServiceHub: () => ({ opener: () => opener }),
}))
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CodeOpenContext, PathRootsContext } from '@/lib/codeOpen'
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
    expect(open).toHaveBeenCalledWith('src/example.ts', {
      line: 12,
      background: false,
    })
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

  describe('inline-code paths', () => {
    const roots = ['C:\\work\\proj']
    const withRoots = (content: string, open?: () => void) => {
      const tree = (
        <PathRootsContext.Provider value={roots}>
          <RenderMarkdown messageId="p" content={content} />
        </PathRootsContext.Provider>
      )
      return render(
        open ? (
          <CodeOpenContext.Provider value={open}>{tree}</CodeOpenContext.Provider>
        ) : (
          tree
        )
      )
    }

    it('opens a relative source path in the Code panel (Cowork)', async () => {
      const open = vi.fn()
      withRoots('Look at `src/a.ts:7` now', open)
      await userEvent.click(await screen.findByRole('button', { name: 'src/a.ts:7' }))
      expect(open).toHaveBeenCalledWith('src/a.ts', { line: 7, background: false })
    })

    it('opens a folder and reveals an executable inside the folders (Chat)', async () => {
      withRoots('Out: `C:\\work\\proj\\dist` and `C:\\work\\proj\\dist\\app.exe`')
      await userEvent.click(await screen.findByRole('button', { name: 'C:\\work\\proj\\dist' }))
      expect(opener.openPath).toHaveBeenCalledWith('C:\\work\\proj\\dist')
      await userEvent.click(screen.getByRole('button', { name: 'C:\\work\\proj\\dist\\app.exe' }))
      expect(opener.revealItemInDir).toHaveBeenCalledWith('C:\\work\\proj\\dist\\app.exe')
      expect(opener.openPath).toHaveBeenCalledTimes(1)
    })

    it('keeps paths outside the folders, relative paths in Chat, and non-paths as plain code', async () => {
      withRoots('`C:\\Windows\\cmd.exe` `C:\\work\\proj2\\a.ts` `src/a.ts` `npm install` `v1.2.3`')
      expect(await screen.findByText('npm install')).toBeInTheDocument()
      expect(screen.queryByRole('button')).toBeNull()
    })
  })
})
