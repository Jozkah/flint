import { describe, it, expect } from 'vitest'
import { errorText, errorDetail } from '@/lib/errorText'

describe('errorText', () => {
  it('never renders a plain object as [object Object]', () => {
    // The reported defect: a Tauri command rejects with an object, and
    // `String(e)` put "Could not be read · [object Object]" on screen.
    const rejection = { code: 'ENOENT', path: '/tmp/CLAUDE.md' }
    const rendered = errorText(rejection)
    expect(rendered).not.toContain('[object Object]')
    expect(rendered).toContain('ENOENT')
  })

  it('prefers a nested message over the shape around it', () => {
    expect(errorText({ code: 500, message: 'disk is full' })).toBe(
      'disk is full'
    )
    expect(errorText({ error: { reason: 'permission denied' } })).toBe(
      'permission denied'
    )
  })

  it('reads a tagged enum the way Rust serialises one', () => {
    expect(errorText({ NotFound: { path: '/etc/hosts' } })).toBe(
      'NotFound: /etc/hosts'
    )
    expect(errorText({ Cancelled: null })).toBe('Cancelled')
  })

  it('passes through the ordinary cases unchanged', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('plain message')).toBe('plain message')
    expect(errorText(404)).toBe('404')
  })

  it('falls back only when there is nothing readable', () => {
    expect(errorText(null)).toBe('Unknown error')
    expect(errorText(undefined, 'no detail')).toBe('no detail')
    expect(errorText({})).toBe('Unknown error')
    expect(errorText('   ')).toBe('Unknown error')
  })

  it('survives a circular object rather than throwing', () => {
    const circular: Record<string, unknown> = { a: 1, b: 2 }
    circular.self = circular
    const rendered = errorText(circular)
    expect(rendered).not.toContain('[object Object]')
    expect(typeof rendered).toBe('string')
  })

  it('bounds how much it will render', () => {
    const rendered = errorText('x'.repeat(5000))
    expect(rendered.length).toBeLessThanOrEqual(400)
    expect(rendered.endsWith('…')).toBe(true)
  })

  it('joins the readable parts of an array', () => {
    expect(errorText(['first', { message: 'second' }])).toBe('first; second')
  })

  it('errorDetail yields empty rather than a fallback', () => {
    expect(errorDetail(null)).toBe('')
    expect(errorDetail({ message: 'kept' })).toBe('kept')
  })
})
