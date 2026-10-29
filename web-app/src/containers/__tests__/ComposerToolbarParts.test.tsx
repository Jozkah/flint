import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ComposerSendButton } from '../ComposerSendButton'
import { ComposerReasoningMenu } from '../ComposerReasoningMenu'
import {
  ComposerErrorLine,
  PathOfferBanner,
  WebSearchOffPrompt,
} from '../ComposerBanners'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) =>
      o?.state ? `${key}:${o.state}` : o?.name ? `${key}:${o.name}` : key,
  }),
  i18n: { t: (k: string) => k },
}))

const wrap = (ui: React.ReactElement) =>
  render(<TooltipProvider>{ui}</TooltipProvider>)

describe('ComposerSendButton', () => {
  const base = {
    isStreaming: false,
    toolInFlight: false,
    onStop: vi.fn(),
    canSend: true,
    ready: true,
    sending: false,
    onSend: vi.fn(),
  }

  it('sends when idle and something can be sent', async () => {
    const onSend = vi.fn()
    wrap(<ComposerSendButton {...base} onSend={onSend} />)
    await userEvent.click(screen.getByLabelText('chat:sendMessage'))
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('is disabled when nothing can be sent', () => {
    wrap(<ComposerSendButton {...base} canSend={false} ready={false} />)
    expect(screen.getByLabelText('chat:sendMessage')).toBeDisabled()
  })

  it('becomes Stop while streaming or while a tool runs', async () => {
    const onStop = vi.fn()
    const { rerender } = wrap(
      <ComposerSendButton {...base} isStreaming onStop={onStop} />
    )
    await userEvent.click(screen.getByLabelText('common:a11y.stopGenerating'))
    expect(onStop).toHaveBeenCalledTimes(1)
    rerender(
      <TooltipProvider>
        <ComposerSendButton {...base} toolInFlight onStop={onStop} />
      </TooltipProvider>
    )
    expect(screen.queryByLabelText('chat:sendMessage')).toBeNull()
    expect(screen.getByLabelText('common:a11y.stopGenerating')).toBeTruthy()
  })
})

describe('ComposerReasoningMenu', () => {
  const setting = (value: unknown) => ({ controller_props: { value } })

  it('reads the model reasoning setting', () => {
    wrap(
      <ComposerReasoningMenu
        selectedProvider="openai"
        modelSettings={{ reasoning: setting('on') }}
        chatOverridesReasoning={false}
        reasoningDefault="off"
        approxContextSize={8192}
        onSetting={vi.fn()}
      />
    )
    expect(
      screen.getByLabelText('chat:composer.reasoningLabel:chat:composer.reasoningOn')
    ).toBeTruthy()
  })

  it('takes "reasoning for new chats" where neither chat nor model chose', () => {
    wrap(
      <ComposerReasoningMenu
        selectedProvider="openai"
        modelSettings={undefined}
        chatOverridesReasoning={false}
        reasoningDefault="off"
        approxContextSize={8192}
        onSetting={vi.fn()}
      />
    )
    expect(
      screen.getByLabelText('chat:composer.reasoningLabel:chat:composer.reasoningOff')
    ).toBeTruthy()
  })

  it('a chat override keeps Auto over the default', () => {
    wrap(
      <ComposerReasoningMenu
        selectedProvider="openai"
        modelSettings={undefined}
        chatOverridesReasoning
        reasoningDefault="off"
        approxContextSize={8192}
        onSetting={vi.fn()}
      />
    )
    expect(
      screen.getByLabelText('chat:composer.reasoningLabel:chat:composer.reasoningAuto')
    ).toBeTruthy()
  })
})

describe('composer banners', () => {
  it('the path offer attaches or declines', async () => {
    const onAccept = vi.fn()
    const onDecline = vi.fn()
    render(
      <PathOfferBanner
        path="/home/me/notes.txt"
        kind="file"
        onAccept={onAccept}
        onDecline={onDecline}
      />
    )
    expect(screen.getByText('common:pastedPath.file:notes.txt')).toBeTruthy()
    await userEvent.click(screen.getByText('common:pastedPath.attach'))
    await userEvent.click(screen.getByLabelText('common:pastedPath.dismiss'))
    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onDecline).toHaveBeenCalledTimes(1)
  })

  it('the web-search-off prompt enables or sends anyway', async () => {
    const onEnable = vi.fn()
    const onSendAnyway = vi.fn()
    render(<WebSearchOffPrompt onEnable={onEnable} onSendAnyway={onSendAnyway} />)
    await userEvent.click(screen.getByText('common:webSearchOff.enable'))
    await userEvent.click(screen.getByText('common:webSearchOff.sendAnyway'))
    expect(onEnable).toHaveBeenCalledTimes(1)
    expect(onSendAnyway).toHaveBeenCalledTimes(1)
  })

  it('the error line shows the message and dismisses', async () => {
    const onDismiss = vi.fn()
    render(<ComposerErrorLine message="too big" onDismiss={onDismiss} />)
    expect(screen.getByRole('alert')).toHaveTextContent('too big')
    await userEvent.click(screen.getByLabelText('common:dismiss'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
