import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

import { ToolImage } from '../tool'

describe('ToolImage', () => {
  it('does not request an https url until the host button is clicked', () => {
    const { container } = render(
      <ToolImage data="https://example.com/a.png" index={0} />
    )
    expect(container.querySelector('img')).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(img).toHaveAttribute('src', 'https://example.com/a.png')
  })

  it('never renders an http: url', () => {
    const { container } = render(
      <ToolImage data="http://example.com/a.png" index={0} />
    )
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders data:image payloads immediately', () => {
    const { container } = render(
      <ToolImage data="data:image/png;base64,AAAA" index={0} />
    )
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'data:image/png;base64,AAAA'
    )
  })

  it('treats bare base64 as png', () => {
    const { container } = render(<ToolImage data="iVBORw0KGgo=" index={0} />)
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'data:image/png;base64,iVBORw0KGgo='
    )
  })

  it('rejects javascript: scheme', () => {
    const { container } = render(
      <ToolImage data="javascript:alert(1)" index={0} />
    )
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
