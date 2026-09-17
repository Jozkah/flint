import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useWebPreview } from '@/hooks/useWebPreview'
import { useWebPreviewSettings } from '@/hooks/useWebPreviewSettings'

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    opener: () => ({ openUrl: vi.fn() }),
    window: () => ({ createWebviewWindow: vi.fn() }),
  }),
}))

import { WebPreviewHost } from '../WebPreviewHost'

const clickAnchor = (href: string) => {
  const a = document.createElement('a')
  a.href = href
  document.body.appendChild(a)
  a.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
  )
  a.remove()
}

describe('WebPreviewHost link interception', () => {
  beforeEach(() => {
    useWebPreview.setState({ open: false, surface: 'side', history: [], index: -1 })
    useWebPreviewSettings.setState({ interceptLinks: true })
  })

  it('opens an external link click in the preview', () => {
    render(<WebPreviewHost />)
    clickAnchor('https://external.example/page')
    expect(useWebPreview.getState().open).toBe(true)
    expect(useWebPreview.getState().url()).toBe('https://external.example/page')
  })

  it('does not intercept when the setting is off', () => {
    useWebPreviewSettings.setState({ interceptLinks: false })
    render(<WebPreviewHost />)
    clickAnchor('https://external.example/page')
    expect(useWebPreview.getState().open).toBe(false)
  })
})
