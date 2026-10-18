import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { MentionHoverCard } from '../MentionHoverCard'

describe('MentionHoverCard preview text', () => {
  it('formats inline markdown instead of printing the markers', () => {
    render(
      <MentionHoverCard
        token="chat:abc"
        preview={{
          token: 'chat:abc',
          kind: 'chat',
          status: 'ok',
          title: 'Pelican',
          messages: 2,
          chars: 40,
          summary: false,
          recent: [{ role: 'assistant', text: 'The codeword is **PELICAN-7419**.' }],
        }}
        style={{}}
        onPointerEnter={() => {}}
        onPointerLeave={() => {}}
      />
    )
    const card = screen.getByTestId('mention-hover-card')
    expect(card.textContent).not.toContain('**')
    expect(screen.getByText('PELICAN-7419')).toHaveClass('font-semibold')
  })
})
