import { render, cleanup, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useEffect } from 'react'

const mounts = vi.hoisted(() => ({ count: 0 }))
vi.mock('streamdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('streamdown')>()
  return {
    ...actual,
    Streamdown: (props: { children?: unknown }) => {
      useEffect(() => {
        mounts.count += 1
      }, [])
      return <div data-testid="md">{String(props.children ?? '')}</div>
    },
  }
})
vi.mock('@i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { RenderMarkdown } from '../RenderMarkdown'
import { useTheme } from '@/hooks/useTheme'

afterEach(() => {
  cleanup()
  mounts.count = 0
})

// A drawn mermaid diagram keeps the colours it was drawn with, so a theme
// switch must draw the message again rather than reuse the old render.
describe('RenderMarkdown when the theme changes', () => {
  it('draws the message again for the new theme, and not for other renders', () => {
    act(() => useTheme.setState({ isDark: true }))
    const { rerender } = render(<RenderMarkdown content="```mermaid\ngraph TD; A-->B\n```" />)
    expect(mounts.count).toBe(1)
    rerender(<RenderMarkdown content="```mermaid\ngraph TD; A-->B\n```" />)
    expect(mounts.count).toBe(1)
    act(() => useTheme.setState({ isDark: false }))
    expect(mounts.count).toBe(2)
  })
})
