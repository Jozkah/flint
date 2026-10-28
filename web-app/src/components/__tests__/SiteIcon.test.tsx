import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { SiteIcon } from '../SiteIcon'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'

const renderIcon = (url: string) =>
  render(
    <SiteIcon
      url={url}
      fallback={<span data-testid="letter">E</span>}
    />
  )

describe('SiteIcon', () => {
  beforeEach(() => {
    useGeneralSetting.setState({ loadSiteIcons: true })
  })

  it('tries the site favicon while showing the letter', () => {
    const { container } = renderIcon('https://example.com/page')
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://example.com/favicon.ico'
    )
    expect(screen.getByTestId('letter')).toBeInTheDocument()
  })

  it('makes no image request and shows the letter when icons are off', () => {
    useGeneralSetting.setState({ loadSiteIcons: false })
    const { container } = renderIcon('https://example.com/page')
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByTestId('letter')).toBeInTheDocument()
  })

  it('never asks a private host for an icon', () => {
    const { container } = renderIcon('http://192.168.1.5/admin')
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByTestId('letter')).toBeInTheDocument()
  })
})
