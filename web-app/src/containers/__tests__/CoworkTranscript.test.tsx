import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const m = vi.hoisted(() => ({ setPrompt: vi.fn(), empty: null as null | Record<string, any> })) // eslint-disable-line @typescript-eslint/no-explicit-any

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))
vi.mock('@/containers/CoworkEmptyState', () => ({
  CoworkEmptyState: (p: Record<string, unknown>) => {
    m.empty = p
    return <div data-testid="empty" />
  },
}))
vi.mock('@/hooks/usePrompt', () => ({
  usePrompt: Object.assign(() => '', { getState: () => ({ setPrompt: m.setPrompt }) }),
}))
vi.mock('@/containers/MessageItem', () => ({
  MessageItem: ({ message }: { message: { id: string } }) => <div data-testid={`msg-${message.id}`} />,
}))
vi.mock('@/components/ai-elements/conversation', () => ({
  Conversation: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConversationContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConversationScrollButton: () => null,
}))
vi.mock('@/lib/coworkTurns', () => ({
  segmentAssistantMessage: (msg: unknown) => [msg],
  workflowSegmentIndex: () => -1,
}))
vi.mock('@/lib/coworkActivity', () => ({ workflowAnchoredAt: () => null }))
vi.mock('@/lib/assistantSwitch', () => ({ switchedFromOf: () => undefined }))

import { CoworkTranscript } from '../CoworkTranscript'

const base = {
  transcriptRef: { current: null },
  displayedTurns: [],
  folder: '/proj',
  effective: { access: 'review' },
  attachFolder: vi.fn(),
  widgetHost: {},
  openToolPath: vi.fn(),
  checkToolPath: vi.fn(),
  toolPathExists: vi.fn(),
  openToolDiff: vi.fn(),
  displayToolPath: (p: string) => p,
  pathLinkRoots: [],
  windowStart: 0,
  setEarlierShown: vi.fn(),
  session: { id: 's1' },
  earlierPages: 0,
  messageWeights: [],
  uiMessages: [],
  activity: { workflows: {}, tasks: {} },
  running: false,
  snapshotByAnchor: new Map(),
  snapshotByMessageId: new Map(),
  runOutcome: null,
  browserReports: [],
  memoryProposals: [],
}

const show = (over: Record<string, unknown> = {}) =>
  render(<CoworkTranscript {...(base as never)} {...(over as never)} />)

describe('CoworkTranscript', () => {
  it('shows the empty state before any turn and wires its actions', async () => {
    show()
    expect(screen.getByTestId('empty')).toBeTruthy()
    expect(m.empty?.folder).toBe('/proj')
    expect(m.empty?.access).toBe('review')
    m.empty?.onPick('hello')
    expect(m.setPrompt).toHaveBeenCalledWith('hello')
    m.empty?.onAttachFolder()
    expect(base.attachFolder).toHaveBeenCalled()
  })

  it('offers earlier messages only when the window hides some, and asks for one more page', async () => {
    const setEarlierShown = vi.fn()
    const { unmount } = show({
      displayedTurns: [{ id: 't1' }],
      uiMessages: [{ id: 'a', parts: [] }, { id: 'b', parts: [] }],
      windowStart: 0,
    })
    expect(screen.queryByTestId('show-earlier-messages')).toBeNull()
    unmount()
    show({
      displayedTurns: [{ id: 't1' }],
      uiMessages: [{ id: 'a', parts: [] }, { id: 'b', parts: [] }],
      windowStart: 1,
      messageWeights: [1, 1],
      setEarlierShown,
    })
    expect(screen.queryByTestId('msg-a')).toBeNull()
    expect(screen.getByTestId('msg-b')).toBeTruthy()
    await userEvent.click(screen.getByTestId('show-earlier-messages'))
    expect(setEarlierShown).toHaveBeenCalledWith({ sid: 's1', pages: 1 })
  })
})
