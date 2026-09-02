import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { codeToHtml } from 'shiki'
import { CodeViewer } from '../CodeViewer'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('shiki', () => ({ codeToHtml: vi.fn() }))

const highlight = codeToHtml as unknown as Mock

/** Highlighting that never settles: the component stays in its fallback. */
const pending = () => highlight.mockReturnValue(new Promise<string>(() => {}))

/** Highlighting that succeeds, tagging the markup with the requested theme so
 * the light and dark panes can be told apart. */
const resolves = () =>
  highlight.mockImplementation((code: string, opts: { theme: string }) =>
    Promise.resolve(
      `<pre class="shiki theme-${opts.theme}"><code>${code}</code></pre>`
    )
  )

/** Replaces `navigator.clipboard`. Called after `userEvent.setup()`, which
 * installs a clipboard stub of its own that would otherwise win. */
const stubClipboard = () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
  return writeText
}

const SOURCE = "export const a = 1\nconsole.log(a)\n"

const defaults = {
  relPath: 'src/a.ts',
  content: SOURCE,
  wordWrap: false,
  onToggleWrap: vi.fn(),
}

describe('CodeViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    highlight.mockReset()
    pending()
  })

  it('shows the raw source while highlighting is still pending', () => {
    render(<CodeViewer {...defaults} onToggleWrap={vi.fn()} />)

    const body = screen.getByTestId('code-viewer-body')
    const pre = body.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toBe(SOURCE)
    expect(body.querySelector('.shiki')).toBeNull()
  })

  it('renders the highlighted markup in both theme containers once resolved', async () => {
    resolves()
    render(<CodeViewer {...defaults} onToggleWrap={vi.fn()} />)

    const body = screen.getByTestId('code-viewer-body')
    await waitFor(() => {
      expect(body.querySelectorAll('.shiki')).toHaveLength(2)
    })

    const panes = body.querySelectorAll(':scope > div')
    expect(panes).toHaveLength(2)
    expect(panes[0].className).toContain('dark:hidden')
    expect(panes[0].innerHTML).toContain('theme-one-light')
    expect(panes[1].className).toContain('dark:block')
    expect(panes[1].innerHTML).toContain('theme-one-dark-pro')

    expect(highlight).toHaveBeenCalledTimes(2)
    expect(highlight).toHaveBeenCalledWith(
      SOURCE,
      expect.objectContaining({ lang: 'typescript', theme: 'one-light' })
    )
    expect(highlight).toHaveBeenCalledWith(
      SOURCE,
      expect.objectContaining({ lang: 'typescript', theme: 'one-dark-pro' })
    )
  })

  it('keeps the source readable when highlighting rejects', async () => {
    highlight.mockRejectedValue(new Error('no grammar for this language'))
    render(<CodeViewer {...defaults} onToggleWrap={vi.fn()} />)

    await waitFor(() => {
      expect(highlight).toHaveBeenCalledTimes(2)
    })

    const body = screen.getByTestId('code-viewer-body')
    expect(body.querySelector('pre')?.textContent).toBe(SOURCE)
    expect(body.querySelector('.shiki')).toBeNull()
  })

  it('shows the relative path and the detected language label', () => {
    render(<CodeViewer {...defaults} onToggleWrap={vi.fn()} />)

    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    expect(screen.getByText('TypeScript')).toBeInTheDocument()
  })

  it('copies the code to the clipboard', async () => {
    const user = userEvent.setup()
    const writeText = stubClipboard()
    render(<CodeViewer {...defaults} onToggleWrap={vi.fn()} />)

    await user.click(
      screen.getByRole('button', { name: 'common:codePanel.copyCode' })
    )

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(SOURCE)
    })
  })

  it('copies the relative path to the clipboard', async () => {
    const user = userEvent.setup()
    const writeText = stubClipboard()
    render(<CodeViewer {...defaults} onToggleWrap={vi.fn()} />)

    await user.click(
      screen.getByRole('button', { name: 'common:codePanel.copyPath' })
    )

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('src/a.ts')
    })
  })

  it('toggles word wrap to the negated value', async () => {
    const user = userEvent.setup()
    const onToggleWrap = vi.fn()
    const { rerender } = render(
      <CodeViewer {...defaults} wordWrap={false} onToggleWrap={onToggleWrap} />
    )

    const wrap = () =>
      screen.getByRole('button', { name: 'common:codePanel.toggleWrap' })

    await user.click(wrap())
    expect(onToggleWrap).toHaveBeenCalledWith(true)

    rerender(
      <CodeViewer {...defaults} wordWrap={true} onToggleWrap={onToggleWrap} />
    )
    await user.click(wrap())
    expect(onToggleWrap).toHaveBeenLastCalledWith(false)
  })

  it('renders content verbatim, odd indentation and trailing spaces included', () => {
    const odd = "  const a = 1   \n\t\tif (a) {   \n\n      return 'x'  \n}\n"
    render(
      <CodeViewer {...defaults} content={odd} onToggleWrap={vi.fn()} />
    )

    const body = screen.getByTestId('code-viewer-body')
    expect(body.textContent).toContain(odd)
    // The highlighter is handed exactly what was on disk, too.
    expect(highlight).toHaveBeenCalledWith(odd, expect.anything())
  })

  it('exposes the body as a focusable region named after the file', () => {
    render(<CodeViewer {...defaults} onToggleWrap={vi.fn()} />)

    const region = screen.getByRole('region', { name: 'src/a.ts' })
    expect(region).toHaveAttribute('tabindex', '0')
    region.focus()
    expect(region).toHaveFocus()
  })
})
