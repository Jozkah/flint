import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RenderMarkdown } from '@/containers/RenderMarkdown'

const renderLink = (href: string) =>
  render(<RenderMarkdown messageId="m1" content={`go [here](${href}) now`} />)

describe('RenderMarkdown link schemes', () => {
  it.each(['http://a.com/x', 'https://a.com/x'])('keeps %s as a link', async (href) => {
    renderLink(href)
    const a = await screen.findByRole('link', { name: 'here' })
    expect(a.getAttribute('href')).toBe(href)
    expect(a.getAttribute('target')).toBe('_blank')
  })

  it('keeps mailto as a link', async () => {
    renderLink('mailto:a@b.com')
    const a = await screen.findByRole('link', { name: 'here' })
    expect(a.getAttribute('href')).toBe('mailto:a@b.com')
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    'jan://settings',
    'file:///C:/x.exe',
    '/relative/page',
    '//evil.com/x',
  ])('renders %s as plain text', async (href) => {
    const { container } = renderLink(href)
    await screen.findByText(/here/)
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('here')
  })

  it('keeps a web citation as a chip, not a raw link', async () => {
    const { container } = renderLink(`#webcite-${encodeURIComponent('https://a.com')}`)
    await screen.findByText(/go/)
    expect(container.textContent).not.toContain('webcite')
    expect(container.querySelector('a[href^="#webcite-"]')).toBeNull()
  })
})
