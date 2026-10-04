import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o?.name ? `${k}#${o.name}` : o?.count !== undefined ? `${k}#${o.count}` : k,
  }),
}))

const { reply, markRead } = vi.hoisted(() => ({ reply: vi.fn(), markRead: vi.fn() }))
vi.mock('@/lib/sessionMailbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sessionMailbox')>()
  return { ...actual, sessionMailbox: { ...actual.sessionMailbox, reply, markRead } }
})

import { AgentMessageCard } from '../AgentMessageCard'
import { AgentMessageHeader } from '../AgentMessageHeader'
import { CoworkHeldInput } from '../CoworkHeldInput'
import { SessionMessagingToggle } from '../SessionMessagingToggle'
import { useMessageQueue } from '@/stores/message-queue-store'
import { useSessionMessaging } from '@/hooks/useSessionMessaging'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { envelopeToQueued } from '@/lib/mailboxDelivery'
import type { MailEnvelope } from '@/lib/sessionMailbox'

const envelope = (text = 'Please **rebase** <img src=x onerror=alert(1)>'): MailEnvelope => ({
  v: 1,
  id: 'm1',
  from: { sessionId: 'S1', displayName: 'Backend' },
  to: { sessionId: 'A' },
  project: 'p',
  text,
  createdAt: 1,
  depth: 0,
  origin: 'agent',
})

const mail = (text?: string) => {
  const m = envelopeToQueued(envelope(text), true)
  return m as typeof m & { from: NonNullable<typeof m.from> }
}

const q = () => useMessageQueue.getState()

describe('AgentMessageCard', () => {
  beforeEach(() => {
    useMessageQueue.setState({ queues: {} })
    useSessionMessaging.setState({ autoWake: {} })
    reply.mockReset()
    markRead.mockReset().mockResolvedValue(undefined)
  })

  it('shows sender and the original text as plain text', () => {
    const m = mail()
    q().enqueue('A', m)
    render(<AgentMessageCard sessionId="A" message={m} />)
    expect(screen.getByRole('region', { name: 'messaging:messageFrom#Backend' })).toBeInTheDocument()
    const text = screen.getByTestId('agent-message-text')
    expect(text.textContent).toBe('Please **rebase** <img src=x onerror=alert(1)>')
    expect(text.querySelector('img, strong')).toBeNull()
  })

  it('replies through the mailbox and confirms', async () => {
    reply.mockResolvedValue({ message_id: 'r1' })
    const m = mail()
    render(<AgentMessageCard sessionId="A" message={m} />)
    fireEvent.click(screen.getByRole('button', { name: 'messaging:replyLabel#Backend' }))
    const box = screen.getByLabelText('messaging:replyLabel#Backend')
    expect(box).toHaveFocus()
    fireEvent.change(box, { target: { value: 'On it' } })
    fireEvent.click(screen.getByTestId('agent-reply-send'))
    await waitFor(() => expect(screen.getByTestId('agent-message-reply-sent')).toBeInTheDocument())
    expect(reply).toHaveBeenCalledWith({ fromSessionId: 'A', replyTo: 'm1', text: 'On it' })
  })

  it('shows a typed refusal inline and keeps the draft', async () => {
    reply.mockRejectedValue('rate_limited: too many')
    render(<AgentMessageCard sessionId="A" message={mail()} />)
    fireEvent.click(screen.getByTestId('agent-message-reply'))
    const box = screen.getByTestId('agent-reply-text')
    fireEvent.change(box, { target: { value: 'hello' } })
    // Keyboard: Ctrl+Enter sends.
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('messaging:errors.rate_limited')
    expect(box).toHaveValue('hello')
    expect(box).toHaveAttribute('aria-invalid', 'true')
  })

  it('Escape cancels the reply', () => {
    render(<AgentMessageCard sessionId="A" message={mail()} />)
    fireEvent.click(screen.getByTestId('agent-message-reply'))
    fireEvent.keyDown(screen.getByTestId('agent-reply-text'), { key: 'Escape' })
    expect(screen.queryByTestId('agent-reply-form')).toBeNull()
    expect(reply).not.toHaveBeenCalled()
  })

  it('dismiss removes it and marks it read; let-respond releases it', () => {
    const m = mail()
    q().enqueue('A', m)
    const { unmount } = render(<AgentMessageCard sessionId="A" message={m} />)
    fireEvent.click(screen.getByRole('button', { name: 'messaging:letAgentRespond' }))
    expect(q().getQueue('A')[0].held).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'messaging:dismiss' }))
    expect(q().getQueue('A')).toEqual([])
    expect(markRead).toHaveBeenCalledWith('A', ['m1'])
    unmount()
  })
})

describe('CoworkHeldInput with mail', () => {
  beforeEach(() => useMessageQueue.setState({ queues: {} }))

  it('shows held mail as cards with the wake-up switch, apart from typed input', () => {
    q().enqueue('A', { id: 'typed', text: 'use pnpm', createdAt: 1, held: true })
    q().enqueue('A', mail())
    render(<CoworkHeldInput sessionId="A" running={false} />)
    const typed = screen.getByTestId('cowork-held-input')
    expect(typed).toHaveTextContent('common:steering.held#1')
    expect(typed).not.toHaveTextContent('rebase')
    expect(screen.getByTestId('cowork-held-mail')).toHaveTextContent('messaging:messageFrom#Backend')
    expect(screen.getByTestId('session-messaging-toggle')).toBeInTheDocument()
  })

  it('renders nothing when only ready mail is queued', () => {
    q().enqueue('A', envelopeToQueued(envelope(), false))
    const { container } = render(<CoworkHeldInput sessionId="A" running />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('SessionMessagingToggle', () => {
  it('has labelled switches, both on by default, persisted per session', () => {
    useSessionMessaging.setState({ autoWake: {}, optOut: {} })
    render(<SessionMessagingToggle sessionId="A" />)
    const wake = screen.getByRole('switch', { name: 'messaging:autoWake.label' })
    expect(wake).toHaveAttribute('aria-checked', 'true')
    expect(wake).toHaveAccessibleDescription('messaging:autoWake.description')
    fireEvent.click(wake)
    expect(useSessionMessaging.getState().autoWake).toEqual({ A: false })
    fireEvent.click(wake)
    expect(useSessionMessaging.getState().autoWake).toEqual({})

    const accept = screen.getByRole('switch', { name: 'messaging:accept.label' })
    expect(accept).toHaveAttribute('aria-checked', 'true')
    expect(accept).toHaveAccessibleDescription('messaging:accept.description')
    fireEvent.click(accept)
    expect(useSessionMessaging.getState().optOut).toEqual({ A: true })
    fireEvent.click(accept)
    expect(useSessionMessaging.getState().optOut).toEqual({})
  })
})

describe('AgentMessageHeader', () => {
  beforeEach(() => {
    reply.mockReset()
    useCoworkSessions.setState({ currentId: 'A' })
  })

  it('renders nothing for an ordinary message', () => {
    const { container } = render(<AgentMessageHeader metadata={{ steered: true }} />)
    expect(container).toBeEmptyDOMElement()
    render(<AgentMessageHeader metadata={{ agentMessage: { displayName: 'x' } }} />)
    expect(screen.queryByTestId('agent-message-header')).toBeNull()
  })

  it('labels the sender and replies as the session in view', async () => {
    reply.mockResolvedValue(undefined)
    render(
      <AgentMessageHeader
        metadata={{ agentMessage: { sessionId: 'S1', displayName: 'Backend', messageId: 'm9' } }}
      />
    )
    expect(screen.getByTestId('agent-message-header')).toHaveTextContent('messaging:messageFrom#Backend')
    fireEvent.click(screen.getByRole('button', { name: 'messaging:replyLabel#Backend' }))
    fireEvent.change(screen.getByTestId('agent-reply-text'), { target: { value: 'ack' } })
    fireEvent.click(screen.getByTestId('agent-reply-send'))
    await screen.findByTestId('agent-message-reply-sent')
    expect(reply).toHaveBeenCalledWith({ fromSessionId: 'A', replyTo: 'm9', text: 'ack' })
  })
})
