import { describe, it, expect } from 'vitest'
import { groupDragAnnouncements } from '../dndAnnouncements'

const t = (key: string, o?: Record<string, unknown>) =>
  o ? `${key} ${Object.values(o).join('|')}` : key

const node = (id: string, label?: unknown) =>
  ({ id, data: { current: label === undefined ? {} : { label } } }) as never

describe('groupDragAnnouncements', () => {
  it('names the chat and the group, never the raw drag ids', () => {
    const a = groupDragAnnouncements(t)
    const msg = a.onDragEnd!({
      active: node('item:abc123', () => 'Weekly planning'),
      over: node('group:g9', 'Alpha'),
    } as never)
    expect(msg).toBe('common:dnd.dropped Weekly planning|Alpha')
    expect(msg).not.toContain('item:')
    expect(msg).not.toContain('group:')
  })

  it('falls back to words when a label is missing', () => {
    const a = groupDragAnnouncements(t)
    expect(a.onDragStart!({ active: node('x') } as never)).toBe(
      'common:dnd.picked common:dnd.anItem'
    )
  })
})
