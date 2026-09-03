import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DiffView } from '../DiffView'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o?.count ? `${k}:${o.count}` : k,
  }),
}))

const DIFF = `@@ -10,4 +10,5 @@ function thing() {
   keep
-  gone
+  added
+  also added
   keep2`

describe('the diff view', () => {
  it('shows both line-number columns', () => {
    render(<DiffView diff={DIFF} />)
    // The first context line is line 10 on both sides, so 10 appears twice —
    // one per gutter. That duplication is the point of having two columns.
    expect(screen.getAllByText('10')).toHaveLength(2)
    // The removal takes 11 on the old side; the additions take 11 and 12 on
    // the new side.
    expect(screen.getAllByText('11')).toHaveLength(2)
    // 12 is the old-side number of the trailing context line and the new-side
    // number of the second addition — the two sides having drifted apart is
    // exactly what the second column exists to show.
    expect(screen.getAllByText('12')).toHaveLength(2)
    expect(screen.getAllByText('13')).toHaveLength(1)
  })

  it('keeps the hunk header and its scope', () => {
    render(<DiffView diff={DIFF} />)
    expect(screen.getByText(/@@ -10,4 \+10,5 @@/)).toBeInTheDocument()
    expect(screen.getByText('function thing() {')).toBeInTheDocument()
  })

  it('marks added and removed lines with a character, not only colour', () => {
    const { container } = render(<DiffView diff={DIFF} />)
    const markers = [...container.querySelectorAll('span[aria-hidden]')].map(
      (s) => s.textContent
    )
    expect(markers).toContain('+')
    expect(markers).toContain('-')
  })

  it('tints added and removed rows differently, and both faintly', () => {
    const { container } = render(<DiffView diff={DIFF} />)
    const rows = [...container.querySelectorAll('tr')].map((r) => r.className)
    const add = rows.find((c) => c.includes('emerald'))
    const remove = rows.find((c) => c.includes('destructive'))
    expect(add).toBeTruthy()
    expect(remove).toBeTruthy()
    // Faint, and stated for both grounds.
    expect(add).toMatch(/dark:/)
    expect(remove).toMatch(/dark:/)
  })

  it('renders the file content, marker stripped', () => {
    const { container } = render(<DiffView diff={DIFF} />)
    // The marker lives in its own span, so the cell's text is marker + content.
    const cells = [...container.querySelectorAll('td')].map((c) => c.textContent)
    expect(cells).toContain('+  added')
    expect(cells).toContain('-  gone')
    // ...and the content itself never carries the marker.
    expect(cells.some((c) => c === '++  added')).toBe(false)
  })

  it('says how much a very long diff omitted', () => {
    const huge = [
      '@@ -1,4000 +1,4000 @@',
      ...Array.from({ length: 4000 }, (_, i) => `+line ${i}`),
    ].join('\n')
    render(<DiffView diff={huge} />)
    expect(screen.getByText(/common:changes\.truncated/)).toBeInTheDocument()
  })

  it('renders nothing for an empty diff rather than an empty frame', () => {
    const { container } = render(<DiffView diff="" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('offers no way to stage, commit or revert', () => {
    // The surface reviews changes already made; it is not an approval screen.
    render(<DiffView diff={DIFF} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
