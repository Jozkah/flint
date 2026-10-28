import { render, cleanup, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RenderMarkdown } from '../RenderMarkdown'

vi.mock('@i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

afterEach(cleanup)

// janhq/jan#9423: each block picks its own direction; code stays LTR.
describe('RenderMarkdown text direction', () => {
  it('gives every block dir=auto and keeps code ltr', async () => {
    const content = [
      'مرحبا بالعالم',
      '',
      'Hello world',
      '',
      '- عنصر',
      '',
      '# عنوان',
      '',
      '> اقتباس',
      '',
      '```js',
      'const x = 1',
      '```',
    ].join('\n')
    const { container } = render(<RenderMarkdown content={content} />)
    await waitFor(() => expect(container.querySelector('li')).toBeTruthy())
    const arabic = [...container.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('مرحبا')
    )
    expect(arabic?.getAttribute('dir')).toBe('auto')
    expect(container.querySelector('li')?.getAttribute('dir')).toBe('auto')
    expect(container.querySelector('h1')?.getAttribute('dir')).toBe('auto')
    expect(container.querySelector('blockquote')?.getAttribute('dir')).toBe('auto')
    await waitFor(() =>
      expect(container.textContent).toContain('const x = 1')
    )
    const codeHost = [...container.querySelectorAll('pre, code')].find((el) =>
      el.textContent?.includes('const x = 1')
    )
    expect(codeHost?.closest('[dir="auto"]:not(.markdown)')).toBeNull()
    expect(
      codeHost?.closest('[dir="ltr"], [data-streamdown="code-block"]')
    ).toBeTruthy()
  })
})
