import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Route as ChatRoute } from '../chat'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'

vi.mock('@/containers/Card', () => ({
  Card: ({ title, children }: { title?: string; children: React.ReactNode }) => (
    <div data-testid="card" data-title={title}>
      {children}
    </div>
  ),
  CardItem: ({
    title,
    actions,
    anchor,
  }: {
    title?: React.ReactNode
    actions?: React.ReactNode
    anchor?: string
  }) => (
    <div data-testid="card-item" data-anchor={anchor}>
      {title}
      {actions}
    </div>
  ),
}))

vi.mock('@/containers/ReplyLanguageSwitcher', () => ({
  default: () => <div data-testid="reply-language-switcher" />,
}))

vi.mock('@/containers/VisualizeSettings', () => ({
  VisualizeSettings: () => <div data-testid="visualize-settings" />,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

vi.mock('@/constants/routes', () => ({
  route: { settings: { chat: '/settings/chat' } },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: { component: unknown }) => config,
}))

const anchors = () =>
  screen
    .getAllByTestId('card-item')
    .map((el) => el.getAttribute('data-anchor'))

describe('Chat settings page', () => {
  beforeEach(() => {
    useInterfaceSettings.getState().resetChatDisplay()
  })

  it('shows composer, replies and links on the first tab', () => {
    const Component = ChatRoute.component as React.ComponentType
    render(<Component />)

    expect(anchors()).toEqual([
      'settings-chat-enter-newline',
      'settings-chat-spell-check',
      'settings-chat-composer-rail-buttons',
      'settings-chat-reply-language',
      'settings-chat-auto-title',
      'settings-chat-strip-reasoning',
      'settings-chat-web-preview',
    ])
    expect(screen.getByTestId('reply-language-switcher')).toBeInTheDocument()
  })

  it('binds Enter adds a new line to the general setting', () => {
    useGeneralSetting.getState().setEnterKeyInsertsNewline(false)
    const Component = ChatRoute.component as React.ComponentType
    render(<Component />)

    const row = screen
      .getAllByTestId('card-item')
      .find((el) => el.dataset.anchor === 'settings-chat-enter-newline')!
    fireEvent.click(row.querySelector('[role="switch"]')!)
    expect(useGeneralSetting.getState().enterKeyInsertsNewline).toBe(true)
  })

  it('shows transcript, artifacts, widgets and reset on the Display tab', () => {
    const Component = ChatRoute.component as React.ComponentType
    render(<Component />)

    fireEvent.click(screen.getByText('settings:chat.tabDisplay'))
    expect(anchors()).toEqual([
      'settings-chat-transcript-view',
      'settings-chat-token-speed',
      'settings-chat-user-markdown',
      'settings-chat-wrap-code-lines',
      'settings-chat-inline-citations',
      'settings-chat-hide-completed',
      'settings-chat-model-received',
      'settings-chat-html-artifacts',
      'settings-chat-reset',
    ])
    expect(screen.getByTestId('transcript-view-picker')).toBeInTheDocument()
    expect(screen.getByTestId('visualize-settings')).toBeInTheDocument()
  })

  it('resets the chat display settings it holds', () => {
    useInterfaceSettings.getState().setWrapCodeLines(true)
    useInterfaceSettings.getState().setTranscriptView('verbose')
    const Component = ChatRoute.component as React.ComponentType
    render(<Component />)

    fireEvent.click(screen.getByText('settings:chat.tabDisplay'))
    fireEvent.click(screen.getByTestId('chat-reset'))
    expect(useInterfaceSettings.getState().wrapCodeLines).toBe(false)
    expect(useInterfaceSettings.getState().transcriptView).not.toBe('verbose')
  })
})
