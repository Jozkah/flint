import { describe, expect, it } from 'vitest'
import en from '../en/model-errors.json'

describe('server port fallback notice', () => {
  it('does not claim the saved port was changed', () => {
    // The server falls back to a free port for this run only; the configured
    // port stays as the user set it, so the notice must not say it was updated.
    const text = en.serverPortFallbackDescription
    expect(text).toContain('{{requested}}')
    expect(text).toContain('{{actual}}')
    expect(text).not.toMatch(/updated/i)
    expect(text).toMatch(/unchanged/i)
  })
})
