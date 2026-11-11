import { render, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'

const seen = vi.hoisted(() => ({ animate: [] as unknown[] }))
vi.mock('streamdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('streamdown')>()
  return {
    ...actual,
    Streamdown: (props: { animate?: unknown; children?: unknown }) => {
      seen.animate.push(props.animate)
      return <div data-testid="md">{String(props.children ?? '')}</div>
    },
  }
})
vi.mock('@i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { RenderMarkdown } from '../RenderMarkdown'

afterEach(() => {
  cleanup()
  seen.animate = []
})

// A finished short reply showed its tokens/sec footer over an empty body: the
// word fade-in started when the stream ended, hiding text already shown.
describe('RenderMarkdown at the end of a stream', () => {
  it('does not fade in again a reply that was streamed', () => {
    const { rerender, getByTestId } = render(
      <RenderMarkdown content="No - 91 = 7x13" isStreaming />
    )
    rerender(<RenderMarkdown content="No - 91 = 7x13" isStreaming={false} />)
    expect(getByTestId('md').textContent).toContain('No - 91 = 7x13')
    expect(seen.animate.every((a) => a === false)).toBe(true)
  })

  it('still fades in a reply that arrived whole', () => {
    render(<RenderMarkdown content="Hello" />)
    expect(seen.animate.at(-1)).toBe(true)
  })
})
