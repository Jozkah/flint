import { render, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RenderMarkdown } from '../RenderMarkdown'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { localStorageKey } from '@/constants/localStorage'

vi.mock('@i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const TOGGLE = '[data-code-wrap-toggle]'
const HEADER = '[data-streamdown="code-block-header"]'
const BODY = '[data-streamdown="code-block-body"]'
const LONG = `const wait = Math.min(base * 2 ** attempt, cap) + ${'x'.repeat(300)}`
const MD = '```ts\n' + LONG + '\nconst b = 2\n```'

describe('RenderMarkdown code block wrapping', () => {
  beforeEach(() => {
    act(() => useInterfaceSettings.getState().setWrapCodeLines(false))
  })

  it('does not wrap by default', async () => {
    const { container } = render(<RenderMarkdown content={MD} />)
    await waitFor(() => expect(container.querySelector(TOGGLE)).not.toBeNull())
    const root = container.querySelector('.markdown')!
    expect(root.hasAttribute('data-code-wrap')).toBe(false)
    expect(container.querySelector(TOGGLE)!.getAttribute('aria-pressed')).toBe(
      'false'
    )
  })

  it('puts the toggle in the block header next to copy/download', async () => {
    const { container } = render(<RenderMarkdown content={MD} />)
    await waitFor(() => expect(container.querySelector(TOGGLE)).not.toBeNull())
    const toggle = container.querySelector(TOGGLE)!
    expect(toggle.closest(HEADER)).not.toBeNull()
    expect(toggle.getAttribute('aria-label')).toBe(
      'settings:interface.wrapCodeLines'
    )
    expect(container.querySelectorAll(TOGGLE)).toHaveLength(1)
  })

  it('toggling wraps every block and remembers it in settings', async () => {
    const { container } = render(<RenderMarkdown content={MD} />)
    await waitFor(() => expect(container.querySelector(TOGGLE)).not.toBeNull())
    fireEvent.click(container.querySelector(TOGGLE)!)
    expect(useInterfaceSettings.getState().wrapCodeLines).toBe(true)
    expect(
      container.querySelector('.markdown')!.getAttribute('data-code-wrap')
    ).toBe('on')
    expect(container.querySelector(TOGGLE)!.getAttribute('aria-pressed')).toBe(
      'true'
    )
    const stored = JSON.parse(
      localStorage.getItem(localStorageKey.settingInterface) ?? '{}'
    )
    expect(stored.state.wrapCodeLines).toBe(true)
  })

  it('renders one row per source line, so a wrapped line keeps one number', async () => {
    const { container } = render(<RenderMarkdown content={MD} />)
    await waitFor(() => expect(container.querySelector(BODY)).not.toBeNull())
    // Each source line is one block row whose ::before is its number; wrapping
    // reflows inside the row, it never adds rows.
    const rows = container.querySelectorAll(`${BODY} > code > span`)
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toBe(LONG)
  })

  it('adds no toggles while streaming', () => {
    const { container } = render(<RenderMarkdown content={MD} isStreaming />)
    expect(container.querySelector(TOGGLE)).toBeNull()
    expect(container.querySelector('pre')).not.toBeNull()
  })
})
