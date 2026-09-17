import { describe, it, expect, beforeEach } from 'vitest'
import { useWebPreview } from '../useWebPreview'

const reset = () =>
  useWebPreview.setState({ open: false, surface: 'side', history: [], index: -1 })

describe('useWebPreview', () => {
  beforeEach(reset)

  it('openUrl opens on the side and records history', () => {
    useWebPreview.getState().openUrl('https://a.com')
    const s = useWebPreview.getState()
    expect(s.open).toBe(true)
    expect(s.surface).toBe('side')
    expect(s.url()).toBe('https://a.com')
    expect(s.canGoBack()).toBe(false)
  })

  it('ignores non-http urls', () => {
    useWebPreview.getState().openUrl('file:///x')
    expect(useWebPreview.getState().open).toBe(false)
  })

  it('navigate pushes and back/forward move through history', () => {
    const st = useWebPreview.getState()
    st.openUrl('https://a.com')
    st.navigate('https://b.com')
    expect(useWebPreview.getState().url()).toBe('https://b.com')
    expect(useWebPreview.getState().canGoBack()).toBe(true)
    useWebPreview.getState().back()
    expect(useWebPreview.getState().url()).toBe('https://a.com')
    expect(useWebPreview.getState().canGoForward()).toBe(true)
    useWebPreview.getState().forward()
    expect(useWebPreview.getState().url()).toBe('https://b.com')
  })

  it('navigate after back truncates the forward tail', () => {
    const st = useWebPreview.getState()
    st.openUrl('https://a.com')
    st.navigate('https://b.com')
    useWebPreview.getState().back()
    useWebPreview.getState().navigate('https://c.com')
    expect(useWebPreview.getState().url()).toBe('https://c.com')
    expect(useWebPreview.getState().canGoForward()).toBe(false)
  })

  it('setSurface changes surface without touching history', () => {
    const st = useWebPreview.getState()
    st.openUrl('https://a.com')
    st.setSurface('pip')
    expect(useWebPreview.getState().surface).toBe('pip')
    expect(useWebPreview.getState().url()).toBe('https://a.com')
  })

  it('close resets open but keeps surface preference', () => {
    const st = useWebPreview.getState()
    st.openUrl('https://a.com')
    st.setSurface('pip')
    useWebPreview.getState().close()
    expect(useWebPreview.getState().open).toBe(false)
    expect(useWebPreview.getState().surface).toBe('pip')
  })
})
