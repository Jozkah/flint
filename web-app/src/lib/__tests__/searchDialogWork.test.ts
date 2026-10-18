import { describe, it, expect } from 'vitest'
import { searchWork, type WorkItem } from '../searchDialogWork'

const items: WorkItem[] = [
  { kind: 'room', id: 'r1', title: 'Compare B' },
  { kind: 'session', id: 's1', title: 'project_search_table' },
  { kind: 'room', id: 'r2', title: 'Design review' },
]

describe('searchWork', () => {
  it('finds a room and a Cowork session by title', () => {
    expect(searchWork(items, 'compare b').map((i) => i.id)).toEqual(['r1'])
    expect(searchWork(items, 'project_search').map((i) => i.id)).toEqual(['s1'])
  })

  it('needs every word, ranks prefix matches first, empty query finds nothing', () => {
    expect(searchWork(items, 'review design').map((i) => i.id)).toEqual(['r2'])
    expect(searchWork(items, 'e').map((i) => i.id)[0]).toBe('r1')
    expect(searchWork(items, '  ')).toEqual([])
  })
})
