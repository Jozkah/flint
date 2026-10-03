import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { Shell } from '../shell/Shell'
import { app, handleEvent } from '../state/app'
import { live } from '../state/live'
import type { Route } from '../state/router'
import type { RemoteAsk } from '@/lib/remote/protocol'
import fx from './fixtures.json'
import { resetApp, useFixtures } from './helpers'

const T = { timeout: 3000 }

const ASK: RemoteAsk = {
  requestId: 'q1',
  threadId: 'w1',
  questions: [
    {
      id: 'lang',
      question: 'Which language should the script use?',
      options: [{ label: 'Python', description: 'Simple and widely installed' }, { label: 'PowerShell' }],
      recommended: 0,
    },
    { id: 'scope', question: 'Which folders should it cover?', options: [{ label: 'Downloads only' }, { label: 'Whole home folder' }], multi: true },
  ],
}

const status = { ...(fx.rpc.status as object), approvalsWaiting: 0, questionsWaiting: 1 }
const waiting = { 'asks.list': { asks: [ASK] }, 'approvals.list': { approvals: [] }, status }

function show(route: Route) {
  resetApp(route)
  return render(<Shell />)
}

describe('a Cowork run’s question on the phone', () => {
  let client: ReturnType<typeof useFixtures>
  beforeEach(() => {
    // One test's answer must not show as the next test's "already answered".
    live.set({ streams: {}, pending: [], resolved: {} })
    client = useFixtures(waiting)
  })

  it('shows the question card and sends the answers, one question at a time', async () => {
    show({ name: 'cowork', id: 'w1' })
    const card = await screen.findByTestId('ask-card', {}, T)
    expect(within(card).getByText('Which language should the script use?')).toBeInTheDocument()
    expect(within(card).getByText('Recommended')).toBeInTheDocument()
    expect(within(card).getByText('1/2')).toBeInTheDocument()
    const next = within(card).getByTestId('ask-submit')
    expect(next).toBeDisabled()
    fireEvent.click(within(card).getByRole('radio', { name: /PowerShell/ }))
    fireEvent.click(next)
    expect(within(card).getByText('Which folders should it cover?')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('checkbox', { name: 'Downloads only' }))
    fireEvent.click(within(card).getByRole('checkbox', { name: 'Whole home folder' }))
    client.rpc.mockImplementationOnce(async () => ({ status: 'answered' }))
    fireEvent.click(within(card).getByRole('button', { name: 'Send answer' }))
    expect(await screen.findByText('Answered · from this phone', {}, T)).toBeInTheDocument()
    expect(client.rpc).toHaveBeenCalledWith('asks.respond', {
      requestId: 'q1',
      threadId: 'w1',
      answers: [
        { id: 'lang', selected: ['PowerShell'] },
        { id: 'scope', selected: ['Downloads only', 'Whole home folder'] },
      ],
    })
  })

  it('takes the user’s own words instead of an option', async () => {
    client = useFixtures({ ...waiting, 'asks.list': { asks: [{ ...ASK, questions: [ASK.questions[0]] }] } })
    show({ name: 'cowork', id: 'w1' })
    const card = await screen.findByTestId('ask-card', {}, T)
    fireEvent.click(within(card).getByTestId('ask-own'))
    fireEvent.change(within(card).getByLabelText('Your answer'), { target: { value: ' Rust, please ' } })
    client.rpc.mockImplementationOnce(async () => ({ status: 'answered' }))
    fireEvent.click(within(card).getByRole('button', { name: 'Send answer' }))
    await screen.findByText('Answered · from this phone', {}, T)
    expect(client.rpc).toHaveBeenCalledWith('asks.respond', {
      requestId: 'q1',
      threadId: 'w1',
      answers: [{ id: 'lang', selected: [], custom_input: 'Rust, please' }],
    })
  })

  it('skips with no answers', async () => {
    show({ name: 'cowork', id: 'w1' })
    const card = await screen.findByTestId('ask-card', {}, T)
    client.rpc.mockImplementationOnce(async () => ({ status: 'answered' }))
    fireEvent.click(within(card).getByRole('button', { name: 'Skip' }))
    expect(await screen.findByText('Skipped · from this phone', {}, T)).toBeInTheDocument()
    expect(client.rpc).toHaveBeenCalledWith('asks.respond', { requestId: 'q1', threadId: 'w1', answers: null })
  })

  it('shows the staged plan under a plan review', async () => {
    const review: RemoteAsk = {
      requestId: 'q2',
      threadId: 'w1',
      questions: [{ id: 'plan_review', question: 'Run this plan?', options: [{ label: 'Execute plan' }, { label: 'Keep planning' }] }],
      plan: [{ name: 'Build', tasks: [{ content: 'Write the script', done: true }, { content: 'Test it', done: false }] }],
    }
    client = useFixtures({ ...waiting, 'asks.list': { asks: [review] } })
    show({ name: 'cowork', id: 'w1' })
    const plan = await screen.findByTestId('ask-plan', {}, T)
    expect(within(plan).getByText('Write the script')).toHaveClass('done')
    expect(within(plan).getByText('Test it')).not.toHaveClass('done')
  })

  it('is counted on the home screen and in the top bar, and opens its session', async () => {
    show({ name: 'home' })
    const card = await screen.findByTestId('question-waiting', {}, T)
    expect(card).toHaveTextContent('has a question')
    expect(card).toHaveTextContent('Which language should the script use?')
    expect(await screen.findByTestId('questions-pill')).toHaveTextContent('1')
    fireEvent.click(card)
    expect(app.get().route).toEqual({ name: 'cowork', id: 'w1' })
  })

  it('announces a new question, and marks one answered on the computer', async () => {
    show({ name: 'cowork', id: 'w1' })
    await screen.findByTestId('ask-card', {}, T)
    handleEvent({ type: 'ask.requested', requestId: 'q9', threadId: 'w2', question: 'Overwrite the file?' })
    expect(app.get().notices[0]).toMatchObject({
      kind: 'approval',
      title: 'Flint has a question',
      body: 'Overwrite the file?',
      route: { name: 'cowork', id: 'w2' },
    })
    handleEvent({ type: 'ask.resolved', requestId: 'q1' })
    expect(await screen.findByText('Answered from the computer', {}, T)).toBeInTheDocument()
    expect(screen.queryByTestId('ask-card')).toBeNull()
  })
})

describe('approvals outside Cowork', () => {
  beforeEach(() => live.set({ streams: {}, pending: [], resolved: {} }))

  it('a chat’s approval is answered on the chat screen, and its notice opens the chat', async () => {
    const approval = { ...(fx.rpc['approvals.list'] as { approvals: Record<string, unknown>[] }).approvals[0], requestId: 'ap7', threadId: 'c1' }
    const client = useFixtures({ 'approvals.list': { approvals: [approval] } })
    show({ name: 'chat', id: 'c1' })
    const card = await screen.findByTestId('approval-card', {}, T)
    client.rpc.mockImplementationOnce(async () => ({ status: 'answered' }))
    fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }))
    expect((await screen.findAllByText('Allowed once · from this phone', {}, T)).length).toBeGreaterThan(0)
    expect(client.rpc).toHaveBeenCalledWith('approvals.respond', { requestId: 'ap7', decision: 'allow', scope: 'once' })
    handleEvent({ type: 'approval.requested', requestId: 'ap8', toolName: 'web_search', threadId: 'c1', kind: 'chat' })
    expect(app.get().notices[0]).toMatchObject({ route: { name: 'chat', id: 'c1' } })
  })

  it('a subagent’s approval says who asks and shows the change', async () => {
    const approval = {
      ...(fx.rpc['approvals.list'] as { approvals: Record<string, unknown>[] }).approvals[0],
      origin: 'reviewer',
      preview: '--- a/x.ts\n+++ b/x.ts\n-old\n+new',
    }
    useFixtures({ 'approvals.list': { approvals: [approval] } })
    show({ name: 'cowork', id: 'w1' })
    const card = await screen.findByTestId('approval-card', {}, T)
    expect(within(card).getByText('from reviewer')).toBeInTheDocument()
    const diff = within(card).getByTestId('approval-diff')
    expect(within(diff).getByText('+new')).toHaveClass('add')
    expect(within(diff).getByText('-old')).toHaveClass('del')
  })
})
