import { render, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { RenderMarkdown } from '../RenderMarkdown'

afterEach(cleanup)

describe('RenderMarkdown images and links', () => {
  it('draws an https image from model output, lazily and without a referrer', () => {
    render(<RenderMarkdown content={'![Ugly Love](https://i.test/ugly-love.jpg)'} />)
    const img = document.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://i.test/ugly-love.jpg')
    expect(img?.getAttribute('alt')).toBe('Ugly Love')
    expect(img?.getAttribute('loading')).toBe('lazy')
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('does not draw an http image', () => {
    render(<RenderMarkdown content={'![x](http://i.test/a.jpg)'} />)
    expect(document.querySelector('img')).toBeNull()
  })

  it('removes an image that fails to load', () => {
    render(<RenderMarkdown content={'![x](https://i.test/dead.jpg)'} />)
    fireEvent.error(document.querySelector('img')!)
    expect(document.querySelector('img')).toBeNull()
  })

  it('opens web links outside the app', () => {
    render(<RenderMarkdown content={'[Ugly Love](https://books.test/ugly-love)'} />)
    const a = document.querySelector('a[href="https://books.test/ugly-love"]')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toContain('noopener')
  })
})
