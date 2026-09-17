import { describe, it, expect } from 'vitest'
import { isPreviewableUrl, clampPipRect, shouldIntercept } from '../webPreview'

const ev = (o: Partial<Parameters<typeof shouldIntercept>[0]> = {}) => ({
  defaultPrevented: false,
  button: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...o,
})

describe('isPreviewableUrl', () => {
  it('accepts http(s) only', () => {
    expect(isPreviewableUrl('https://a.com')).toBe(true)
    expect(isPreviewableUrl('http://a.com')).toBe(true)
    expect(isPreviewableUrl('file:///x')).toBe(false)
    expect(isPreviewableUrl('javascript:alert(1)')).toBe(false)
    expect(isPreviewableUrl('not a url')).toBe(false)
  })
})

describe('clampPipRect', () => {
  it('keeps the rect inside the viewport', () => {
    const r = clampPipRect({ x: -50, y: -50, w: 400, h: 300 }, { w: 1000, h: 800 })
    expect(r.x).toBe(0)
    expect(r.y).toBe(0)
    const r2 = clampPipRect({ x: 900, y: 700, w: 400, h: 300 }, { w: 1000, h: 800 })
    expect(r2.x).toBe(600)
    expect(r2.y).toBe(500)
  })
  it('caps size to the viewport with min floors', () => {
    const r = clampPipRect({ x: 0, y: 0, w: 5000, h: 5000 }, { w: 1000, h: 800 })
    expect(r.w).toBe(1000)
    expect(r.h).toBe(800)
  })
})

describe('shouldIntercept', () => {
  const app = 'https://app.local'
  const a = (o: Partial<{ href: string; target: string; origin: string }> = {}) => ({
    href: 'https://ext.com/page',
    target: '',
    origin: 'https://ext.com',
    ...o,
  })
  it('intercepts a plain external http(s) click', () => {
    expect(shouldIntercept(ev(), a(), app)).toBe(true)
  })
  it('skips when no anchor', () => {
    expect(shouldIntercept(ev(), null, app)).toBe(false)
  })
  it('skips same-origin (in-app route) links', () => {
    expect(shouldIntercept(ev(), a({ href: `${app}/settings`, origin: app }), app)).toBe(false)
  })
  it('skips non-http schemes', () => {
    expect(shouldIntercept(ev(), a({ href: 'mailto:x@y.com', origin: 'null' }), app)).toBe(false)
  })
  it('force-external on modifier or middle click', () => {
    expect(shouldIntercept(ev({ metaKey: true }), a(), app)).toBe(false)
    expect(shouldIntercept(ev({ ctrlKey: true }), a(), app)).toBe(false)
    expect(shouldIntercept(ev({ shiftKey: true }), a(), app)).toBe(false)
    expect(shouldIntercept(ev({ button: 1 }), a(), app)).toBe(false)
  })
  it('skips already-handled events', () => {
    expect(shouldIntercept(ev({ defaultPrevented: true }), a(), app)).toBe(false)
  })
})
