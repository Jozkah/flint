import { describe, it, expect } from 'vitest'
import { searchSettings, type SettingsIndexEntry } from '@/lib/settingsSearch'

const entry = (id: string, title: string, keywords: string[] = [], description = ''): SettingsIndexEntry => ({
  kind: 'setting',
  id,
  route: `/settings/${id}`,
  title,
  section: 'Settings',
  description,
  keywords,
})

describe('searchSettings ranking', () => {
  it('lists a title or keyword that contains the query before looser matches', () => {
    const index = [
      entry('chunk', 'Chunk Size', ['chunk', 'embedding']),
      entry('net', 'Network Proxy', ['proxy', 'network', 'ssl']),
      entry('prox', 'Proxy URL', ['proxy url']),
    ]
    const found = searchSettings(index, 'proxy')
    expect(found.slice(0, 2).map((e) => e.id).sort()).toEqual(['net', 'prox'])
  })

  it('keeps Fuse order when nothing matches exactly', () => {
    const index = [entry('a', 'Reply language'), entry('b', 'Reasoning effort')]
    expect(searchSettings(index, 'reasning')[0]?.id).toBe('b')
  })
})
