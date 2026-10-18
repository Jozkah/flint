import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConversationEntry, ConversationSnapshot } from '@/lib/chatMentions'
import { mentionToken, buildExcerpt, joinMentionBlocks } from '@/lib/chatMentions'

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  select: vi.fn(),
  entries: [] as ConversationEntry[],
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}|${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => h.navigate }))
vi.mock('@/hooks/useCoworkSessions', () => ({
  useCoworkSessions: { getState: () => ({ selectSession: h.select }) },
}))
vi.mock('@/lib/chatMentionSources', () => ({
  listConversations: () => h.entries,
  listConversationsAsync: async () => h.entries,
  loadSnapshot: async (e: Pick<ConversationEntry, 'kind' | 'id'>): Promise<ConversationSnapshot | null> => {
    const found = h.entries.find((x) => x.id === e.id)
    return found
      ? {
          kind: found.kind,
          id: found.id,
          title: found.title,
          messages: [
            { role: 'user', text: 'one' },
            { role: 'assistant', text: 'two' },
          ],
        }
      : null
  },
}))

import { FilePickerPopover } from '@/components/FilePickerPopover'
import { MentionChips } from '@/containers/MentionChips'
import { SentMentions } from '@/containers/SentMentions'
import { rankConversations } from '@/lib/chatMentionMenu'

const chat: ConversationEntry = {
  kind: 'chat',
  id: 'chat0000000000aaaa',
  title: 'Release notes',
  project: 'Flint',
  updated: Date.now() - 3 * 86_400_000,
  messageCount: 12,
  preview: 'We agreed to ship on Friday',
}
const session: ConversationEntry = { kind: 'session', id: 'sess0000000000bbbb', title: 'Fix login', updated: Date.now() - 60_000, messageCount: 4 }
const twin: ConversationEntry = { ...chat, id: 'chat0000000000cccc', project: undefined, messageCount: undefined, preview: undefined }

beforeEach(() => {
  h.navigate.mockReset()
  h.select.mockReset()
  h.entries = [chat, session]
})
afterEach(() => cleanup())

function menu(entries: ReturnType<typeof rankConversations>, extra: Partial<Parameters<typeof FilePickerPopover>[0]> = {}) {
  render(
    <FilePickerPopover
      entries={entries}
      query="rel"
      open
      activeIndex={0}
      onActiveChange={() => {}}
      onSelect={() => {}}
      onClose={() => {}}
      listId="refs"
      aliasDraft={null}
      onAliasSave={() => {}}
      onAliasCancel={() => {}}
      {...extra}
    />
  )
}

describe('conversation rows in the menu', () => {
  it('show title, kind badge, breadcrumb, age, message count and a preview', () => {
    menu(rankConversations('', [chat, session]), { triggerChar: '#' })
    const rows = screen.getAllByRole('option')
    expect(rows).toHaveLength(2)
    const row = rows.find((r) => r.getAttribute('data-kind') === 'chat')!
    expect(row.textContent).toContain('Release notes')
    expect(row.textContent).toContain('common:mentions.kind.chat')
    expect(row.textContent).toContain('Flint')
    expect(row.textContent).toContain('common:mentions.messages|{"n":12}')
    expect(row.textContent).toContain('We agreed to ship on Friday')
    expect(row.textContent).toMatch(/3 days ago/)
    expect(row.getAttribute('data-token')).toMatch(/^chat:release-notes-[a-z0-9]{8}$/)
    expect(screen.getByText('#rel')).toBeTruthy()
  })

  it('labels duplicate titles so they can be told apart', () => {
    menu(rankConversations('', [chat, twin]))
    const labels = screen.getAllByTestId('mention-label').map((l) => l.textContent)
    expect(labels).toHaveLength(2)
    expect(new Set(labels).size).toBe(2)
    expect(labels).toContain('Flint')
  })

  it('puts a Chats heading before the conversations that follow other kinds', () => {
    const entries = [
      { kind: 'skill', token: 'skill:rel', name: 'rel' },
      ...rankConversations('', [chat]),
    ] as Parameters<typeof FilePickerPopover>[0]['entries']
    menu(entries)
    expect(screen.getByTestId('reference-group-chats').textContent).toBe('common:mentions.heading')
  })

  it('shows the empty state instead of nothing', () => {
    menu([], { emptyMessage: 'common:mentions.empty', triggerChar: '#' })
    expect(screen.getByTestId('reference-menu').textContent).toBe('common:mentions.empty')
  })

  it('stays hidden with no entries and no empty message, as before', () => {
    menu([])
    expect(screen.queryByTestId('reference-menu')).toBeNull()
  })

  it('selects with a click like any row', () => {
    const onSelect = vi.fn()
    menu(rankConversations('', [chat]), { onSelect })
    fireEvent.click(screen.getAllByRole('option')[0])
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'chat' }))
  })
})

describe('MentionChips', () => {
  const token = mentionToken('chat', chat.id, chat.title)

  it('shows nothing without a mention', () => {
    render(<MentionChips prompt="hello" onChange={() => {}} canSummarize={false} />)
    expect(screen.queryByTestId('mention-chips')).toBeNull()
  })

  it('shows a chip and one totals line, with messages and tokens', async () => {
    render(<MentionChips prompt={`look at @${token} now`} onChange={() => {}} canSummarize={false} />)
    await waitFor(() => expect(screen.getByTestId('mention-chip')).toBeTruthy(), { timeout: 2000 })
    expect(screen.getByTestId('mention-chip').textContent).toContain('Release notes')
    const status = screen.getByTestId('mention-status').textContent ?? ''
    expect(status).toContain('common:mentions.totals')
    expect(status).toContain('"count":2')
    expect(status).toMatch(/"tokens":"\d+"/)
    // The title is said once, on the chip, not again in the status line.
    expect(status).not.toContain('Release notes')
    expect(screen.getByTestId('mention-status').getAttribute('data-warn')).toBe('false')
    expect(screen.queryByTestId('mention-summarize')).toBeNull()
    expect(screen.getByTestId('mention-info').getAttribute('aria-label')).toBe('common:mentions.readOnly')
  })

  it('shows a loading chip while a typed mention is looked up', () => {
    render(<MentionChips prompt={`@${token}`} previews={[]} onChange={() => {}} canSummarize={false} />)
    expect(screen.getByTestId('mention-chip-loading').textContent).toContain('common:mentions.resolving')
  })

  it('turns the line amber over a quarter of the window and offers a summary', async () => {
    const onChange = vi.fn()
    render(<MentionChips prompt={`@${token}`} onChange={onChange} canSummarize contextWindow={4} />)
    await waitFor(() => screen.getByTestId('mention-chip'), { timeout: 2000 })
    const status = screen.getByTestId('mention-status')
    expect(status.getAttribute('data-warn')).toBe('true')
    expect(status.textContent).toContain('common:mentions.tooLarge')
    fireEvent.click(screen.getByTestId('mention-use-summary'))
    expect(onChange).toHaveBeenCalledWith(`@${token}#summary`)
  })

  it('stays calm with a large window', async () => {
    render(<MentionChips prompt={`@${token}`} onChange={() => {}} canSummarize contextWindow={128000} />)
    await waitFor(() => screen.getByTestId('mention-chip'), { timeout: 2000 })
    expect(screen.getByTestId('mention-status').getAttribute('data-warn')).toBe('false')
    expect(screen.queryByTestId('mention-use-summary')).toBeNull()
  })

  it('removes the mention from the prompt', async () => {
    const onChange = vi.fn()
    render(<MentionChips prompt={`look at @${token} now`} onChange={onChange} canSummarize={false} />)
    await waitFor(() => screen.getByTestId('mention-remove'), { timeout: 2000 })
    fireEvent.click(screen.getByTestId('mention-remove'))
    expect(onChange).toHaveBeenCalledWith('look at now')
  })

  it('toggles a summary only when a model can write one', async () => {
    const onChange = vi.fn()
    render(<MentionChips prompt={`@${token}`} onChange={onChange} canSummarize />)
    await waitFor(() => screen.getByTestId('mention-summarize'), { timeout: 2000 })
    expect(screen.getByTestId('mention-excerpt').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('mention-summarize').getAttribute('aria-checked')).toBe('false')
    // The mode already on does nothing.
    fireEvent.click(screen.getByTestId('mention-excerpt'))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('mention-summarize'))
    expect(onChange).toHaveBeenCalledWith(`@${token}#summary`)
  })

  it('shows Summary as on for a #summary mention, and switches back', async () => {
    const onChange = vi.fn()
    render(<MentionChips prompt={`@${token}#summary`} onChange={onChange} canSummarize />)
    await waitFor(() => screen.getByTestId('mention-summarize'), { timeout: 2000 })
    expect(screen.getByTestId('mention-chip').getAttribute('data-mode')).toBe('summary')
    expect(screen.getByTestId('mention-summarize').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('mention-excerpt'))
    expect(onChange).toHaveBeenCalledWith(`@${token}`)
  })

  it('flags a deleted conversation without blocking anything', async () => {
    render(<MentionChips prompt="@chat:gone-99999999" onChange={() => {}} canSummarize={false} />)
    await waitFor(() => screen.getByTestId('mention-chip'), { timeout: 2000 })
    expect(screen.getByTestId('mention-chip').getAttribute('data-status')).toBe('missing')
  })

  it('keeps the current conversation out and says why', async () => {
    render(<MentionChips prompt={`@${token}`} currentId={chat.id} onChange={() => {}} canSummarize={false} />)
    await waitFor(() => screen.getByTestId('mention-chip'), { timeout: 2000 })
    expect(screen.getByTestId('mention-chip').getAttribute('data-status')).toBe('self')
  })

  it('does not preview a mention inside a code fence', async () => {
    render(<MentionChips prompt={'```\n@' + token + '\n```'} onChange={() => {}} canSummarize={false} />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400))
    })
    expect(screen.queryByTestId('mention-chip')).toBeNull()
  })
})

describe('SentMentions', () => {
  const records = [
    { kind: 'chat' as const, id: chat.id, titleAtSend: 'Release notes', chars: 100 },
    { kind: 'session' as const, id: session.id, titleAtSend: 'Fix login', chars: 50 },
    { kind: 'room' as const, id: 'room-gone', titleAtSend: 'Deleted room', chars: 10 },
  ]

  it('renders chips that open the conversation', () => {
    render(<SentMentions mentions={records} />)
    const chips = screen.getAllByTestId('sent-mention-chip')
    expect(chips).toHaveLength(3)
    expect(chips[0].textContent).toContain('Release notes')
    expect(chips[0].getAttribute('aria-label')).toBe('common:mentions.open|{"title":"Release notes"}')
    fireEvent.click(chips[0])
    expect(h.navigate).toHaveBeenCalledWith({ to: '/threads/$threadId', params: { threadId: chat.id } })
    fireEvent.click(chips[1])
    expect(h.select).toHaveBeenCalledWith(session.id)
    expect(h.navigate).toHaveBeenLastCalledWith({ to: '/cowork' })
  })

  it('shows a deleted conversation dimmed and inert, under its old title', () => {
    render(<SentMentions mentions={records} />)
    const gone = screen.getAllByTestId('sent-mention-chip')[2] as HTMLButtonElement
    expect(gone.disabled).toBe(true)
    expect(gone.getAttribute('data-exists')).toBe('false')
    expect(gone.textContent).toContain('Deleted room')
  })

  it('renders nothing for no mentions', () => {
    render(<SentMentions mentions={[]} />)
    expect(screen.queryByTestId('sent-mentions')).toBeNull()
  })

  it('reads the records back from a sent message', () => {
    const { block } = buildExcerpt({ kind: 'chat', id: chat.id, title: chat.title, messages: [{ role: 'user', text: 'x' }] })
    expect(joinMentionBlocks('t', [block])).toContain('<conversation-mention')
  })
})
