import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BlurWords } from '../blur-words'
import { blurWordsDelay } from '@/lib/blur-words'

describe('BlurWords', () => {
  it('keeps the whole greeting readable', () => {
    const { container } = render(
      <h1>
        <BlurWords text="Good evening, Jozkah" trailing={<i>x</i>} />
      </h1>
    )
    expect(screen.getByRole('heading')).toHaveTextContent(
      'Good evening, Jozkah'
    )
    expect(screen.getByText('Good evening, Jozkah')).toHaveClass('sr-only')
    const words = container.querySelectorAll('.bw-word')
    expect(words).toHaveLength(3)
    words.forEach((w, i) =>
      expect((w as HTMLElement).style.getPropertyValue('--bw-i')).toBe(
        String(i)
      )
    )
    expect(container.querySelector('[aria-hidden="true"]')).toContainElement(
      words[0] as HTMLElement
    )
  })

  it('times follow-ups after the last word', () => {
    expect(blurWordsDelay('Good evening, Jozkah')).toBe(780)
  })
})
