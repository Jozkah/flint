import { describe, expect, it } from 'vitest'
import { needsWeb } from '../needsWeb'

describe('needsWeb', () => {
  it('flags links and explicit web requests', () => {
    expect(needsWeb('can you read https://example.com/post/1')).toBe(true)
    expect(needsWeb('search for the latest tauri release')).toBe(true)
    expect(needsWeb('Could you google that error')).toBe(true)
    expect(needsWeb('look it up online')).toBe(true)
    expect(needsWeb('open this link please')).toBe(true)
  })

  it('leaves ordinary coding requests alone', () => {
    expect(needsWeb('')).toBe(false)
    expect(needsWeb('fix the search bar in the sidebar')).toBe(false)
    expect(needsWeb('add a binary search to utils.ts')).toBe(false)
    expect(needsWeb('why does the camera reset on deploy?')).toBe(false)
  })
})
