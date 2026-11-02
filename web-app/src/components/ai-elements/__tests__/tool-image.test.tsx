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

  // janhq/jan#9547: an MCP image result carries its type beside the payload.
  it('builds the data url from the result mimeType', () => {
    const { container } = render(
      <ToolImage data="/9j/4AAQ" mimeType="image/jpeg" index={0} />
    )
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,/9j/4AAQ'
    )
  })

  it('falls back to png for a mimeType that is not an image type', () => {
    const { container } = render(
      <ToolImage data="AAAA" mimeType="text/html;x" index={0} />
    )
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'data:image/png;base64,AAAA'
    )
  })

  it('shows a placeholder when the image fails to load', () => {
    const { container } = render(
      <ToolImage data="not-an-image" mimeType="image/png" index={0} />
    )
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByTestId('tool-image-failed')).toHaveTextContent(
      'uiLeftovers:toolOutputImageFailed'
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
