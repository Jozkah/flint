import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CardItem } from '../Card'

describe('CardItem description', () => {
  it('clamps a plain description to one line by default', () => {
    render(<CardItem title="T" description="Short words" />)
    expect(screen.getByText('Short words').className).toContain('line-clamp-1')
  })

  it('shows the whole description with wrapDescription', () => {
    render(<CardItem title="T" description="Warning: read all of this" wrapDescription />)
    const d = screen.getByText('Warning: read all of this')
    expect(d.className).not.toContain('line-clamp-1')
    expect(d).not.toHaveAttribute('title')
  })
})
