import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/components/ai-elements/code-block', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="source">{code}</pre>,
}))
vi.mock('@/components/ai-elements/shimmer', () => ({
  Shimmer: ({ children }: { children: string }) => <span>{children}</span>,
}))
vi.mock('@/i18n/react-i18next-compat', async () => {
  const chat = (await import('@/locales/en/chat.json')).default as Record<string, unknown>
  const t = (key: string, vars: Record<string, unknown> = {}) => {
    const path = key.replace(/^chat:/, '').split('.')
    const found = path.reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], chat)
    return typeof found === 'string'
      ? found.replace(/\{\{(\w+)\}\}/g, (_, n) => String(vars[n] ?? ''))
      : key
  }
  return { useTranslation: () => ({ t }) }
})
const openUrl = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/browserOpen', () => ({ openInBrowser: (u: string) => openUrl(u) }))

import { WidgetCard } from '../WidgetCard'
import { LOAD_AFTER_READY_GRACE_MS } from '../WidgetFrame'
import { WidgetHostContext } from '@/lib/visualize/hostContext'
import { useVisualizeConfig } from '@/hooks/useVisualizeConfig'
import { MAX_WIDGET_CODE_CHARS } from '@/lib/visualize/constants'

const part = (over: Record<string, unknown> = {}) =>
  ({
    type: 'tool-show_widget',
    toolCallId: 'c1',
    state: 'output-available',
    input: { title: 'My flow', widget_code: '<div class="card">hi</div>' },
    output: 'Widget rendered: My flow, 26 chars.',
    ...over,
  }) as never

const frameOf = () => screen.getByTestId('widget-frame') as HTMLIFrameElement

function fromFrame(data: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', { data, source: frameOf().contentWindow })
    )
  })
}

beforeEach(() => {
  useVisualizeConfig.setState({ enabled: true, allowCdn: false, maxHeight: 640 })
  openUrl.mockClear()
})

describe('WidgetCard', () => {
  it('renders the caption and a sandboxed frame without same-origin', () => {
    render(<WidgetCard part={part()} messageId="m" />)
    expect(screen.getByText('My flow')).toBeInTheDocument()
    const frame = frameOf()
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(frame.getAttribute('srcdoc')).toContain("connect-src 'none'")
  })

  it('collapses and expands from the caption', () => {
    render(<WidgetCard part={part()} messageId="m" />)
    fireEvent.click(screen.getByRole('button', { name: /My flow/ }))
    expect(screen.queryByTestId('widget-body')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /My flow/ }))
    expect(screen.getByTestId('widget-body')).toBeInTheDocument()
  })

  it('toggles the source view and keeps the frame mounted', () => {
    render(<WidgetCard part={part()} messageId="m" />)
    fireEvent.click(screen.getByLabelText('View source'))
    expect(screen.getByTestId('source').textContent).toBe('<div class="card">hi</div>')
    expect(frameOf()).toBeInTheDocument()
  })

  it('shows a streaming card with the loading line until it paints', () => {
    render(
      <WidgetCard
        part={part({
          state: 'input-streaming',
          input: { title: 'Draft', loading_messages: ['Laying out'], widget_code: '<di' },
          output: undefined,
        })}
        messageId="m"
      />
    )
    expect(screen.getByText('Laying out')).toBeInTheDocument()
    expect(screen.getByText('Drawing widget')).toBeInTheDocument()
  })

  it('shows a script error banner and asks to fix through the host', () => {
    const sendPrompt = vi.fn().mockReturnValue(true)
    render(
      <WidgetHostContext.Provider value={{ sendPrompt }}>
        <WidgetCard part={part()} messageId="m" />
      </WidgetHostContext.Provider>
    )
    fromFrame({ flint: 1, op: 'error', message: 'x is not defined' })
    expect(screen.getByTestId('widget-error').textContent).toContain('x is not defined')
    fireEvent.click(screen.getByText('Ask Flint to fix'))
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(sendPrompt.mock.calls[0][0]).toContain('x is not defined')
    fireEvent.click(screen.getByText('View source'))
    expect(screen.getByTestId('source')).toBeInTheDocument()
  })

  it('ignores messages that do not come from its frame', () => {
    render(<WidgetCard part={part()} messageId="m" />)
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { flint: 1, op: 'error', message: 'spoof' } })
      )
    })
    expect(screen.queryByTestId('widget-error')).toBeNull()
  })

  it('drops sendPrompt without a user gesture, sends it with one', () => {
    const sendPrompt = vi.fn().mockReturnValue(true)
    render(
      <WidgetHostContext.Provider value={{ sendPrompt }}>
        <WidgetCard part={part()} messageId="m" />
      </WidgetHostContext.Provider>
    )
    fromFrame({ flint: 1, op: 'sendPrompt', text: 'hello' })
    expect(sendPrompt).not.toHaveBeenCalled()
    Object.defineProperty(navigator, 'userActivation', {
      value: { isActive: true },
      configurable: true,
    })
    fromFrame({ flint: 1, op: 'sendPrompt', text: 'hello' })
    expect(sendPrompt).toHaveBeenCalledWith('hello')
    Object.defineProperty(navigator, 'userActivation', { value: undefined, configurable: true })
  })

  it('asks before opening a link, then opens it', () => {
    Object.defineProperty(navigator, 'userActivation', {
      value: { isActive: true },
      configurable: true,
    })
    render(<WidgetCard part={part()} messageId="m" />)
    fromFrame({ flint: 1, op: 'openLink', text: '', url: 'https://example.com/docs' })
    expect(screen.getByTestId('widget-link-confirm').textContent).toContain('https://example.com/docs')
    expect(openUrl).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Open'))
    expect(openUrl).toHaveBeenCalledWith('https://example.com/docs')
    Object.defineProperty(navigator, 'userActivation', { value: undefined, configurable: true })
  })

  it('shows why a refused call drew nothing', () => {
    render(
      <WidgetCard
        part={part({ state: 'output-error', errorText: 'Too many widgets', output: undefined })}
        messageId="m"
      />
    )
    expect(screen.getByTestId('widget-refused').textContent).toContain('Too many widgets')
    expect(screen.queryByTestId('widget-frame')).toBeNull()
  })

  it('does not draw an oversized widget', () => {
    render(
      <WidgetCard
        part={part({ input: { title: 'Big', widget_code: 'x'.repeat(MAX_WIDGET_CODE_CHARS + 1) } })}
        messageId="m"
      />
    )
    expect(screen.queryByTestId('widget-frame')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('200000')
  })

  it('drops a frame that navigates itself after it announced the shell', () => {
    vi.useFakeTimers()
    try {
      render(<WidgetCard part={part()} messageId="m" />)
      fireEvent.load(screen.getByTestId('widget-frame'))
      expect(screen.queryByTestId('widget-stalled')).toBeNull()
      fromFrame({ flint: 1, op: 'ready' })
      act(() => vi.advanceTimersByTime(LOAD_AFTER_READY_GRACE_MS + 100))
      fireEvent.load(screen.getByTestId('widget-frame'))
      expect(screen.getByTestId('widget-stalled')).toBeInTheDocument()
      expect(screen.queryByTestId('widget-frame')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a widget whose shell finishes loading just after it announced itself', () => {
    // The shell posts `ready` from an inline script while its own document is
    // still loading; in WebView2 the frame's `load` followed 3 ms later and the
    // widget was dropped as "navigated away", every time.
    render(<WidgetCard part={part()} messageId="m" />)
    fireEvent.load(screen.getByTestId('widget-frame'))
    fromFrame({ flint: 1, op: 'ready' })
    fireEvent.load(screen.getByTestId('widget-frame'))
    expect(screen.queryByTestId('widget-stalled')).toBeNull()
    expect(screen.getByTestId('widget-frame')).toBeInTheDocument()
  })

  it('replaces a frame that stops sending its heartbeat, and re-runs on request', () => {
    vi.useFakeTimers()
    try {
      render(<WidgetCard part={part()} messageId="m" />)
      fromFrame({ flint: 1, op: 'ready' })
      act(() => vi.advanceTimersByTime(6000))
      fromFrame({ flint: 1, op: 'beat' })
      act(() => vi.advanceTimersByTime(6000))
      expect(screen.queryByTestId('widget-stalled')).toBeNull()
      act(() => vi.advanceTimersByTime(6000))
      expect(screen.getByTestId('widget-stalled').textContent).toContain('stopped responding')
      expect(screen.queryByTestId('widget-frame')).toBeNull()
      fireEvent.click(screen.getByText('Re-run'))
      expect(screen.getByTestId('widget-frame')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
