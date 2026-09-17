import { describe, it, expect } from 'vitest'
import { useWebPreviewSettings } from '../useWebPreviewSettings'

describe('useWebPreviewSettings', () => {
  it('defaults interception on and toggles', () => {
    expect(useWebPreviewSettings.getState().interceptLinks).toBe(true)
    useWebPreviewSettings.getState().setInterceptLinks(false)
    expect(useWebPreviewSettings.getState().interceptLinks).toBe(false)
    useWebPreviewSettings.getState().setInterceptLinks(true)
  })
})
