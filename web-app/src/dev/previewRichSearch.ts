/**
 * Development-only: `?preview&richsearch` adds a chat continued from a summary
 * (its seed message is raw Markdown) and answers message search from the
 * seeded messages, so the rich search snippets and the seed bubble can be
 * looked at in a plain browser. Off unless the parameter is present.
 */
import type { Thread, ThreadMessage } from '@janhq/core'
import { useThreads } from '@/hooks/useThreads'
import { useMessages } from '@/hooks/useMessages'
import { messageSearchDev, type MessageHit } from '@/lib/messageSearch'

const ID = 'capitals-cont'
const TITLE = 'Capitals quiz (continued)'
const SEED = [
  'This chat continues an earlier one, "Capitals quiz". Here is a summary of it, for reference. It is not a new request.',
  '',
  '* **User Goal:** learn the capitals of a few countries',
  '**Key Facts:**',
  '* Capital of France: Paris',
  '* Capital of Japan: Tokyo',
  '* Use `capitals.json` for the list; see [the atlas](https://example.com/atlas)',
  '**Decisions:** None.',
].join('\n')
const REPLY =
  'Next up: the capital of **Australia** is *Canberra*, not Sydney.\n\n## Quick check\n- Paris\n- Tokyo\n- Canberra\n\n```json\n{"au": "Canberra"}\n```'

export const richSearchEnabled = () =>
  new URLSearchParams(window.location.search).has('richsearch')

const textOf = (m: ThreadMessage) =>
  (m.content ?? [])
    .map((c) => (c.type === 'text' ? (c.text?.value ?? '') : ''))
    .join('\n')

/** The backend's snippet window (search.rs): 48 chars each side, one line. */
function snippet(text: string, at: number, len: number): string {
  const from = Math.max(0, at - 48)
  const to = Math.min(text.length, at + len + 48)
  const body = text.slice(from, to).replace(/\s/g, ' ').trim()
  return `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`
}

export function seedRichSearch() {
  if (!richSearchEnabled()) return
  const msg = (id: string, role: 'user' | 'assistant', value: string, metadata = {}) =>
    ({
      id,
      role,
      object: 'thread.message',
      thread_id: ID,
      status: 'ready',
      created_at: Date.now(),
      completed_at: Date.now(),
      content: [{ type: 'text', text: { value, annotations: [] } }],
      metadata,
    }) as unknown as ThreadMessage
  useThreads.getState().setThreads([
    ...Object.values(useThreads.getState().threads),
    {
      id: ID,
      title: TITLE,
      updated: Date.now() / 1000,
      assistants: [],
      model: { id: 'claude-sonnet-5', provider: 'anthropic' },
      metadata: { continuedFrom: { threadId: 'capitals', title: 'Capitals quiz' } },
    } as unknown as Thread,
  ])
  useMessages.getState().setMessages(ID, [
    msg('cs1', 'user', SEED, { continuedFrom: { threadId: 'capitals', title: 'Capitals quiz' } }),
    msg('cs2', 'assistant', REPLY),
  ])
  messageSearchDev.search = (query, limit) => {
    const q = query.toLowerCase()
    const hits: MessageHit[] = []
    const all = useMessages.getState().messages
    for (const [threadId, list] of Object.entries(all)) {
      const title = useThreads.getState().threads[threadId]?.title ?? threadId
      for (const m of list ?? []) {
        const text = textOf(m)
        const at = text.toLowerCase().indexOf(q)
        if (at === -1) continue
        hits.push({
          threadId,
          threadTitle: title,
          messageId: m.id,
          role: m.role,
          snippet: snippet(text, at, q.length),
          updated: Date.now() / 1000,
        })
      }
    }
    return hits.slice(0, limit)
  }
}
