import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { codeToHtml } from 'shiki'
import { CodeViewer } from '../CodeViewer'
import { clearHighlightCache } from '@/lib/highlightCache'
import { useTheme } from '@/hooks/useTheme'

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
    // The cache is module-level and would otherwise carry markup between
    // cases, hiding the very calls these tests count.
    clearHighlightCache()
    useTheme.setState({ isDark: false })
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

  it('renders the highlighted markup for the active theme only', async () => {
    resolves()
    render(<CodeViewer {...defaults} onToggleWrap={vi.fn()} />)

    const body = screen.getByTestId('code-viewer-body')
    await waitFor(() => {
      expect(body.querySelectorAll('.shiki')).toHaveLength(1)
    })

    // One pane, tokenised once: highlighting both themes and hiding one with
    // CSS doubled the work for output that was never shown.
    expect(body.querySelectorAll(':scope > div')).toHaveLength(1)
    expect(body.innerHTML).toContain('theme-one-light')
    expect(body.innerHTML).not.toContain('theme-one-dark-pro')

    expect(highlight).toHaveBeenCalledTimes(1)
    expect(highlight).toHaveBeenCalledWith(
      SOURCE,
      expect.objectContaining({ lang: 'typescript', theme: 'one-light' })
    )
  })

  it('re-highlights once when the theme changes', async () => {
    resolves()
    render(<CodeViewer {...defaults} onToggleWrap={vi.fn()} />)
    await waitFor(() => expect(highlight).toHaveBeenCalledTimes(1))

    act(() => useTheme.setState({ isDark: true }))

    await waitFor(() => {
      expect(screen.getByTestId('code-viewer-body').innerHTML).toContain(
        'theme-one-dark-pro'
      )
    })
    expect(highlight).toHaveBeenCalledTimes(2)
    expect(highlight).toHaveBeenLastCalledWith(
      SOURCE,
      expect.objectContaining({ theme: 'one-dark-pro' })
    )
  })

  it('serves a re-opened file from cache instead of tokenising again', async () => {
    resolves()
    const { unmount } = render(
      <CodeViewer {...defaults} onToggleWrap={vi.fn()} />
    )
    await waitFor(() => expect(highlight).toHaveBeenCalledTimes(1))
    unmount()

    render(<CodeViewer {...defaults} onToggleWrap={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('code-viewer-body').innerHTML).toContain(
        'shiki'
      )
    })
    expect(highlight).toHaveBeenCalledTimes(1)
  })

  it('keeps the source readable when highlighting rejects', async () => {
    highlight.mockRejectedValue(new Error('no grammar for this language'))
    render(<CodeViewer {...defaults} onToggleWrap={vi.fn()} />)

    await waitFor(() => {
      expect(highlight).toHaveBeenCalledTimes(1)
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

// Highlighting that stamps each line the way the real transformer does, so a
// selection can be mapped back to a line by structure rather than by text.
const REPEATED = 'if (a) {\n  run()\n}\nif (b) {\n  run()\n}\n'

const resolvesWithLines = () =>
  highlight.mockImplementation((code: string, opts: { theme: string }) =>
    Promise.resolve(
      `<pre class="shiki theme-${opts.theme}"><code>` +
        code
          .split('\n')
          .map(
            (line, i) =>
              `<span class="line" data-cv-line="${i + 1}">${line}</span>`
          )
          .join('\n') +
        '</code></pre>'
    )
  )

/** Select the whole text of the rendered line `n` in the visible pane. */
const selectLine = (n: number) => {
  const body = screen.getByTestId('code-viewer-body')
  // Two panes are rendered (light and dark); either maps to the same lines.
  const line = body.querySelector(`[data-cv-line="${n}"]`)!
  const range = document.createRange()
  range.selectNodeContents(line)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  fireEvent.mouseUp(body)
}

describe('CodeViewer selection → line range', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    highlight.mockReset()
    clearHighlightCache()
    useTheme.setState({ isDark: false })
    resolvesWithLines()
  })

  it('reports the line that was selected, not the first identical one', async () => {
    // The regression: the range came from `content.indexOf(selectedText)`, so
    // selecting the second `run()` reported line 2 — the first match — and the
    // reference sent to the model pointed at the wrong place. Both `run()`
    // lines are byte-identical, so only the DOM knows which one was selected.
    const onAddToChat = vi.fn()
    render(
      <CodeViewer
        {...defaults}
        content={REPEATED}
        onToggleWrap={vi.fn()}
        onAddToChat={onAddToChat}
      />
    )
    await waitFor(() =>
      expect(
        screen.getByTestId('code-viewer-body').querySelector('[data-cv-line]')
      ).not.toBeNull()
    )

    selectLine(5)
    // fireEvent, not userEvent: userEvent emulates a full pointer sequence
    // that collapses the document selection before the click, which is the
    // very gesture `onMouseDown`'s preventDefault exists to survive in a real
    // browser. Driving the click directly keeps this test about line mapping.
    fireEvent.click(screen.getByText('common:codePanel.addToChat'))

    expect(onAddToChat).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'src/a.ts',
        startLine: 5,
        endLine: 5,
        code: '  run()',
      })
    )
  })

  it('reports the first one when that is the one selected', async () => {
    const onAddToChat = vi.fn()
    render(
      <CodeViewer
        {...defaults}
        content={REPEATED}
        onToggleWrap={vi.fn()}
        onAddToChat={onAddToChat}
      />
    )
    await waitFor(() =>
      expect(
        screen.getByTestId('code-viewer-body').querySelector('[data-cv-line]')
      ).not.toBeNull()
    )

    selectLine(2)
    fireEvent.click(screen.getByText('common:codePanel.addToChat'))

    expect(onAddToChat).toHaveBeenCalledWith(
      expect.objectContaining({ startLine: 2, endLine: 2 })
    )
  })

  it('offers nothing when an ambiguous selection cannot be placed', async () => {
    // Highlighting has not resolved, so there are no stamped lines to read and
    // the text alone is ambiguous. Reporting a guess would put a wrong line
    // range in the prompt, so the action is withheld instead.
    highlight.mockReset()
    pending()
    render(
      <CodeViewer
        {...defaults}
        content={REPEATED}
        onToggleWrap={vi.fn()}
        onAddToChat={vi.fn()}
      />
    )

    const body = screen.getByTestId('code-viewer-body')
    const pre = body.querySelector('pre')!
    const range = document.createRange()
    // "  run()" occurs twice in the raw text.
    range.setStart(pre.firstChild!, REPEATED.indexOf('  run()'))
    range.setEnd(pre.firstChild!, REPEATED.indexOf('  run()') + 7)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    fireEvent.mouseUp(body)

    expect(
      screen.queryByText('common:codePanel.addToChat')
    ).not.toBeInTheDocument()
  })
})
