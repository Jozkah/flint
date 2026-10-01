import { describe, it, expect } from 'vitest'
import { renderMarkdown, renderObsidian } from '../exportMarkdown'
import { docFromThread } from '../exportDoc'

const now = new Date('2026-10-01T10:00:00Z')

const msg = (
  id: string,
  role: 'user' | 'assistant',
  text: string,
  created_at: number,
  metadata: Record<string, unknown>
) => ({
  id,
  role,
  created_at,
  metadata,
  content: [{ type: 'text', text: { value: text, annotations: [] } }],
})

// u1 -> a1 (shown), and u1 -> a2 -> u2 -> a3 (another branch).
const stored = [
  msg('u1', 'user', 'question', 1, { parentId: null, activeChildId: 'a1' }),
  msg('a1', 'assistant', 'first answer', 2, { parentId: 'u1' }),
  msg('a2', 'assistant', 'second answer', 3, { parentId: 'u1' }),
  msg('u2', 'user', 'follow up', 4, { parentId: 'a2' }),
  msg('a3', 'assistant', 'final', 5, { parentId: 'u2' }),
] as never

describe('branched threads', () => {
  it('exports only the shown branch by default and says which one it is', () => {
    const doc = docFromThread({ id: 't', title: 'B' }, stored, now)
    expect(doc.scope).toBe('branch')
    expect(doc.branch).toEqual({ index: 1, count: 2 })
    expect(doc.messages.map((m) => m.text)).toEqual(['question', 'first answer'])
    const md = renderMarkdown(doc)
    expect(md).toContain('Branch 1 of 2')
    expect(md).not.toContain('second answer')
    const note = renderObsidian(doc)
    expect(note).toContain('type: chat-branch')
    expect(note).toContain('branch: 1')
  })

  it('follows the other branch when the thread has switched to it', () => {
    const switched = (
      stored as unknown as { id: string; metadata: Record<string, unknown> }[]
    ).map((m) =>
      m.id === 'u1' ? { ...m, metadata: { ...m.metadata, activeChildId: 'a2' } } : m
    ) as never
    const doc = docFromThread({ id: 't', title: 'B' }, switched, now)
    expect(doc.messages.map((m) => m.text)).toEqual([
      'question',
      'second answer',
      'follow up',
      'final',
    ])
    expect(doc.branch).toEqual({ index: 2, count: 2 })
  })

  it('nests the other versions when asked, with what followed them', () => {
    const doc = docFromThread({ id: 't', title: 'B' }, stored, now, {
      allVersions: true,
    })
    expect(doc.scope).toBe('thread')
    expect(doc.branch).toBeUndefined()
    expect(doc.messages).toHaveLength(2)
    expect(doc.messages[1].alternatives?.[0].map((m) => m.text)).toEqual([
      'second answer',
      'follow up',
      'final',
    ])
    const md = renderMarkdown(doc)
    expect(md).toContain('> **Other version 1 of this message**')
    expect(md).toContain('> second answer')
    expect(md).toContain('> ## User')
  })

  it('a linear thread is a plain thread with no branch note', () => {
    const doc = docFromThread(
      { id: 't', title: 'L' },
      [msg('x', 'user', 'hi', 1, {}), msg('y', 'assistant', 'yo', 2, {})] as never,
      now,
      { allVersions: true }
    )
    expect(doc.scope).toBe('thread')
    expect(doc.branch).toBeUndefined()
    expect(doc.messages.every((m) => !m.alternatives)).toBe(true)
  })
})
