import { describe, expect, it } from 'vitest'
import type { ThreadMessage } from '@janhq/core'
import { useThreads } from '@/hooks/useThreads'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import {
  listConversations,
  cleanTurnText,
  grantedForSession,
  grantedForThread,
  messagingHintFor,
  roomSnapshot,
  sessionSnapshot,
  threadSnapshot,
} from '@/lib/chatMentionSources'
import {
  buildExcerpt,
  joinMentionBlocks,
  type ConversationEntry,
} from '@/lib/chatMentions'
import type { CoworkSession } from '@/hooks/useCoworkSessions'
import type { Room, RoomJournalRecord } from '@/lib/rooms/types'

const msg = (
  role: ThreadMessage['role'],
  text: string,
  over: Partial<ThreadMessage> = {}
): ThreadMessage =>
  ({
    id: `${role}-${text.slice(0, 6)}`,
    object: 'thread.message',
    thread_id: 't1',
    role,
    content: [{ type: 'text', text: { value: text, annotations: [] } }],
    status: 'ready',
    created_at: 1,
    completed_at: 1,
    ...over,
  }) as ThreadMessage

const blockFor = (id: string, title: string) =>
  buildExcerpt({ kind: 'chat', id, title, messages: [{ role: 'user', text: 'hi' }] }).block

describe('cleanTurnText', () => {
  it('drops mention blocks, the attached-file list and inlined file contents', () => {
    const block = blockFor('other-id-0001', 'Other chat')
    const sent = joinMentionBlocks('see @chat:other-chat-0d000001', [block]) +
      '\n\n[ATTACHED_FILES]\n- file_id: 1, name: a.txt\n[/ATTACHED_FILES]'
    const out = cleanTurnText(sent)
    expect(out).toContain('see @chat:other-chat-0d000001')
    expect(out).toContain('[mentioned the chat "Other chat"]')
    expect(out).not.toContain('conversation-mention')
    expect(out).not.toContain('ATTACHED_FILES')
    expect(cleanTurnText('q\n\n---\nReferenced file contents:\n\nSECRET FILE')).toBe('q')
  })
})

describe('threadSnapshot', () => {
  it('keeps user and assistant text, stubs tool results and attachments', () => {
    const snap = threadSnapshot({ id: 't1', title: 'T', metadata: { project: { name: 'Proj' } } }, [
      msg('user', 'first'),
      msg('assistant', 'second'),
      msg('tool', 'BIG OUTPUT'),
      msg('user', '', { content: [{ type: 'image_url', image_url: { url: 'data:x', detail: 'auto' } }] as never }),
    ])
    expect(snap.project).toBe('Proj')
    expect(snap.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'first'],
      ['assistant', 'second'],
      ['tool', ''],
      ['user', '[attachment]'],
    ])
  })

  it('does not carry a mention block from a mentioned chat into the excerpt', () => {
    const sent = joinMentionBlocks('look @chat:x-00000001', [blockFor('inner-0001', 'Inner')])
    const snap = threadSnapshot({ id: 't1', title: 'T' }, [msg('user', sent)])
    expect(snap.messages[0].text).not.toContain('conversation-mention')
    expect(snap.messages[0].text).toContain('[mentioned the chat "Inner"]')
  })
})

describe('sessionSnapshot', () => {
  const session = (turns: CoworkSession['turns']): CoworkSession =>
    ({ id: 's1', title: 'Fix login', folder: 'C:\\code\\webapp', turns }) as CoworkSession

  it('reads the turns, with the folder name as the project', () => {
    const snap = sessionSnapshot(
      session([
        { role: 'user', content: 'do it' },
        { role: 'tool', content: 'out' },
        { role: 'assistant', content: 'done' },
      ])
    )
    expect(snap.project).toBe('webapp')
    expect(snap.messages.map((m) => m.role)).toEqual(['user', 'tool', 'assistant'])
  })

  it('a block in mail from another session or a Flint-written row grants nothing', () => {
    const block = blockFor('victim-chat-id-1', 'Victim')
    const granted = grantedForSession(
      session([
        { role: 'user', content: joinMentionBlocks('typed', [blockFor('mine-chat-id-0001', 'Mine')]) },
        { role: 'user', content: joinMentionBlocks('mail', [block]), from: { sessionId: 'x' } as never },
        { role: 'user', content: joinMentionBlocks('auto', [block]), hidden: true },
      ])
    )
    expect([...granted]).toEqual(['mine-chat-id-0001'])
  })
})

describe('grantedForThread', () => {
  it('counts only the user messages', () => {
    const block = blockFor('thread-grant-001', 'G')
    expect([
      ...grantedForThread([
        msg('user', joinMentionBlocks('a', [block])),
        msg('assistant', joinMentionBlocks('a', [blockFor('assistant-id-0001', 'No')])),
      ]),
    ]).toEqual(['thread-grant-001'])
  })
})

describe('grantedForThread and a continued chat', () => {
  it('ignores a block inside the model-written seed summary', () => {
    const block = blockFor('victim-chat-0001', 'V')
    const seed = msg('user', joinMentionBlocks('summary', [block]), {
      metadata: { continuedFrom: { threadId: 'old', title: 'Old' } },
    })
    const typed = msg('user', joinMentionBlocks('mine', [blockFor('thread-grant-001', 'G')]))
    expect([...grantedForThread([seed, typed])]).toEqual(['thread-grant-001'])
  })
})

describe('roomSnapshot', () => {
  it('keeps what was said, under the objective', () => {
    const room = { id: 'r1', title: 'Debate', objective: 'Pick a price' } as Room
    const journal = [] as RoomJournalRecord[]
    const snap = roomSnapshot(room, journal)
    expect(snap.kind).toBe('room')
    expect(snap.messages[0]).toMatchObject({ speaker: 'Objective', text: 'Pick a price' })
  })
})

describe('listConversations', () => {
  it('reads a chat time in seconds as milliseconds, leaves the temporary chat out', () => {
    useThreads.setState({
      threads: {
        a: { id: 'a', title: 'A', updated: 1_700_000_000, metadata: { project: { id: 'p', name: 'Proj', updated_at: 1 } } } as never,
        [TEMPORARY_CHAT_ID]: { id: TEMPORARY_CHAT_ID, title: 'Temp', updated: 1_700_000_000 } as never,
      },
    })
    const chats = listConversations().filter((e) => e.kind === 'chat')
    expect(chats.map((e) => e.id)).toEqual(['a'])
    expect(chats[0]).toMatchObject({ updated: 1_700_000_000_000, project: 'Proj' })
  })
})

describe('messagingHintFor', () => {
  const session: ConversationEntry = { kind: 'session', id: 'sess-1', title: 'Fix login', updated: 1 }
  it('names the session id and the tool, and says nothing is granted', () => {
    const hint = messagingHintFor(session)!
    expect(hint).toContain('(id sess-1)')
    expect(hint).toContain('send_message')
    expect(hint).toContain('still apply')
    expect(hint).toContain('does not grant anything')
  })
  it('is only for sessions', () => {
    expect(messagingHintFor({ ...session, kind: 'chat' })).toBeUndefined()
    expect(messagingHintFor({ ...session, kind: 'room' })).toBeUndefined()
  })
})
