import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AvatarEmoji } from '../AvatarEmoji'

describe('AvatarEmoji Component', () => {
  it('should return null when no avatar is provided', () => {
    const { container } = render(<AvatarEmoji />)
    expect(container.firstChild).toBeNull()
  })

  it('should return null when avatar is undefined', () => {
    const { container } = render(<AvatarEmoji avatar={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('should render image when avatar is a custom image path', () => {
    render(<AvatarEmoji avatar="/images/custom-avatar.png" />)
    
    const img = screen.getByRole('img')
    expect(img).toBeDefined()
    expect(img).toHaveAttribute('src', '/images/custom-avatar.png')
    expect(img).toHaveAttribute('alt', 'Custom avatar')
  })

  // C061: the pale Quartz crystal was ~1.5:1 on a white tile in light theme.
  it('rims the pale Quartz icon with the light-theme rim token', () => {
    render(<AvatarEmoji avatar="/images/assistants/quartz.png" />)
    expect(screen.getByRole('img').className).toContain('var(--icon-rim)')
  })

  it('should apply default image className', () => {
    render(<AvatarEmoji avatar="/images/avatar.jpg" />)
    
    const img = screen.getByRole('img')
    expect(img).toHaveClass('w-5', 'h-5', 'object-contain')
  })

  it('should apply custom image className', () => {
    render(
      <AvatarEmoji 
        avatar="/images/avatar.jpg" 
        imageClassName="w-10 h-10 rounded-full" 
      />
    )
    
    const img = screen.getByRole('img')
    expect(img).toHaveClass('w-10', 'h-10', 'rounded-full')
    expect(img).not.toHaveClass('w-5', 'h-5', 'object-contain')
  })

  it('should render emoji as text span', () => {
    render(<AvatarEmoji avatar="🤖" />)
    
    const span = screen.getByText('🤖')
    expect(span.tagName).toBe('SPAN')
  })

  it('should apply default text className for emoji', () => {
    render(<AvatarEmoji avatar="😊" />)
    
    const span = screen.getByText('😊')
    expect(span).toHaveClass('text-base')
  })

  it('should apply custom text className for emoji', () => {
    render(
      <AvatarEmoji 
        avatar="🎯" 
        textClassName="text-lg font-bold" 
      />
    )
    
    const span = screen.getByText('🎯')
    expect(span).toHaveClass('text-lg', 'font-bold')
    expect(span).not.toHaveClass('text-base')
  })

  it('should render text content as span', () => {
    render(<AvatarEmoji avatar="AI" />)
    
    const span = screen.getByText('AI')
    expect(span.tagName).toBe('SPAN')
    expect(span).toHaveClass('text-base')
  })

  it('should handle React node as avatar', () => {
    const customNode = <div data-testid="custom-node">Custom</div>
    render(<AvatarEmoji avatar={customNode} />)
    
    const span = screen.getByText('Custom')
    expect(span.closest('span')).toHaveClass('text-base')
    expect(screen.getByTestId('custom-node')).toBeDefined()
  })

  it('should not treat non-image paths as custom images', () => {
    render(<AvatarEmoji avatar="/api/data" />)
    
    const span = screen.getByText('/api/data')
    expect(span.tagName).toBe('SPAN')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('should not treat relative paths as custom images', () => {
    render(<AvatarEmoji avatar="images/avatar.png" />)
    
    const span = screen.getByText('images/avatar.png')
    expect(span.tagName).toBe('SPAN')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('should handle different image extensions', () => {
    const extensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg']
    
    extensions.forEach((ext, index) => {
      const { unmount } = render(<AvatarEmoji avatar={`/images/avatar${ext}`} />)
      
      const img = screen.getByRole('img')
      expect(img).toHaveAttribute('src', `/images/avatar${ext}`)
      
      unmount()
    })
  })

  it('should maintain accessibility for custom images', () => {
    render(<AvatarEmoji avatar="/images/user-avatar.png" />)
    
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('alt', 'Custom avatar')
  })
})

describe('AvatarEmoji dark-theme lift', () => {
  it('lifts the dim Coal and Flint icons in dark mode only', () => {
    const { rerender } = render(<AvatarEmoji avatar="/images/assistants/coal.png" />)
    expect(screen.getByRole('img').className).toMatch(/dark:\[filter:brightness/)
    rerender(<AvatarEmoji avatar="/images/flint-logo.png" />)
    expect(screen.getByRole('img').className).toMatch(/dark:\[filter:brightness/)
    rerender(<AvatarEmoji avatar="/images/assistants/emerald.png" />)
    expect(screen.getByRole('img').className).not.toMatch(/brightness/)
  })
})
