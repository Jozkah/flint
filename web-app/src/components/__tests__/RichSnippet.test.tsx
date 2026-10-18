import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { RichSnippet } from '@/components/RichSnippet'

describe('RichSnippet', () => {
  it('renders formatting and marks the match inside bold', () => {
    const { container } = render(
      <RichSnippet text="…* Capital of France: **Paris** * `code` here…" query="paris" />
    )
    expect(container.textContent).toBe('…Capital of France: Paris · code here…')
    const mark = container.querySelector('mark')!
    expect(mark.textContent).toBe('Paris')
    expect(mark.querySelector('[data-style="bold"]')).toBeTruthy()
    expect(container.querySelector('[data-style="code"]')?.textContent).toBe('code')
  })

  it('never creates elements from message HTML', () => {
    const { container } = render(
      <RichSnippet text={'x <img src=x onerror="alert(1)"> <b>y</b> [z](javascript:alert(1))'} query="" />
    )
    expect(container.querySelector('img, b, a, script')).toBeNull()
    expect(container.innerHTML).not.toContain('onerror')
    expect(container.innerHTML).not.toContain('javascript:')
  })
})
