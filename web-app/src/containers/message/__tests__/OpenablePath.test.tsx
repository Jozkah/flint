import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, v?: Record<string, unknown>) =>
      v ? `${k}#${Object.values(v).join(',')}` : k,
  }),
}))

import { OpenablePath } from '../OpenablePath'
import { CodeOpenProvider } from '../CodeOpenProvider'

const setup = (
  props: Partial<Parameters<typeof OpenablePath>[0]> = {},
  check?: (p: string) => { ok: true } | { ok: false; reason: string }
) => {
  const open = vi.fn()
  const openDiff = vi.fn()
  render(
    <CodeOpenProvider open={open} check={check} openDiff={openDiff}>
      <OpenablePath path="src/a.ts" {...props} />
    </CodeOpenProvider>
  )
  return { open, openDiff }
}

describe('OpenablePath', () => {
  it('opens at the line on click and on Enter', () => {
    const { open } = setup({ line: 42 })
    const link = screen.getByTestId('openable-path')
    fireEvent.click(link)
    expect(open).toHaveBeenLastCalledWith('src/a.ts', {
      line: 42,
      background: false,
    })
    fireEvent.keyDown(link, { key: 'Enter' })
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('opens in the background on Ctrl+click and middle-click', () => {
    const { open } = setup()
    const link = screen.getByTestId('openable-path')
    fireEvent.click(link, { ctrlKey: true })
    expect(open).toHaveBeenLastCalledWith('src/a.ts', {
      line: undefined,
      background: true,
    })
    fireEvent(
      link,
      new MouseEvent('auxclick', { bubbles: true, button: 1 })
    )
    expect(open).toHaveBeenCalledTimes(2)
    expect(open.mock.calls[1][1]).toEqual({ line: undefined, background: true })
  })

  it('offers the diff for a changed file', () => {
    const { openDiff, open } = setup({ diffable: true })
    fireEvent.click(screen.getByTestId('open-diff'))
    expect(openDiff).toHaveBeenCalledWith('src/a.ts')
    expect(open).not.toHaveBeenCalled()
  })

  it('stays text with the reason when the path cannot be resolved', () => {
    setup({}, () => ({ ok: false, reason: 'Outside the folders' }))
    expect(screen.queryByTestId('openable-path')).toBeNull()
    expect(screen.getByTestId('openable-path-unresolved')).toHaveAttribute(
      'title',
      'Outside the folders'
    )
  })

  it('is plain text where there is no Code panel', () => {
    render(<OpenablePath path="src/a.ts" />)
    expect(screen.queryByTestId('openable-path')).toBeNull()
    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
  })

  it('shows the short form, keeps the full path in the tooltip and on copy', () => {
    const full =
      'C:/Users/me/AppData/Roaming/Flint/data/agent-workspace/sessions/s1/src/a.ts'
    render(
      <CodeOpenProvider open={vi.fn()} displayPath={() => 'src/a.ts'}>
        <OpenablePath path={full} />
      </CodeOpenProvider>
    )
    const link = screen.getByTestId('openable-path')
    expect(link).toHaveTextContent(/^src\/a\.ts$/)
    expect(link.getAttribute('title')).toContain(full)
    const setData = vi.fn()
    fireEvent.copy(link, { clipboardData: { setData } })
    expect(setData).toHaveBeenCalledWith('text/plain', full)
  })
})
