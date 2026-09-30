import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { HuggingFaceAvatar } from '../HuggingFaceAvatar'

describe('HuggingFaceAvatar', () => {
  it('asks for the organisation picture first, then the user, then falls back', () => {
    const { container } = render(<HuggingFaceAvatar author="some-author" />)
    let img = container.querySelector('img')!
    expect(img.getAttribute('src')).toContain('/api/organizations/some-author/avatar')
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')

    fireEvent.error(img)
    img = container.querySelector('img')!
    expect(img.getAttribute('src')).toContain('/api/users/some-author/avatar')

    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('S')
  })

  it('never builds a request from something that is not an author name', () => {
    const { container } = render(<HuggingFaceAvatar author="../evil?x=1" />)
    expect(container.querySelector('img')).toBeNull()
  })
})
