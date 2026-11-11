import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/platform/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/utils')>()),
  isPlatformTauri: () => true,
}))
import { buildSettingsIndex, searchSettings, type SettingsIndexEntry } from '@/lib/settingsSearch'

// The real English strings, so the ranking is tested against the labels people see.
const locales = import.meta.glob('@/locales/en/*.json', { eager: true }) as Record<
  string,
  { default: Record<string, unknown> }
>
const byNs: Record<string, Record<string, unknown>> = {}
for (const [path, mod] of Object.entries(locales)) {
  byNs[path.split('/').pop()!.replace('.json', '')] = mod.default
}
const t = (key: string): string => {
  const [ns, rest] = key.includes(':') ? key.split(':', 2) : ['common', key]
  let node: unknown = byNs[ns]
  for (const part of rest.split('.')) node = (node as Record<string, unknown> | undefined)?.[part]
  return typeof node === 'string' ? node : key
}

const index = buildSettingsIndex(t)
const titles = (q: string) => searchSettings(index, q).map((e: SettingsIndexEntry) => e.title)

describe('settings search ranking over the real index', () => {
  it('finds Accent colour first for "accent"', () => {
    expect(titles('accent')[0]).toBe('Accent colour')
  })

  it('still finds Theme for "theme" and lists the proxy setting first for "proxy"', () => {
    expect(titles('theme')[0]).toBe(t('settings:interface.theme'))
    expect(titles('proxy')[0]).toMatch(/proxy/i)
  })

  it('puts a title that starts with the query before loose fuzzy hits', () => {
    const index2: SettingsIndexEntry[] = [
      ...Array.from({ length: 25 }, (_, i) => ({
        kind: 'setting' as const,
        id: `n${i}`,
        route: '/settings/x',
        title: `Attachments ${i}`,
        section: 'S',
        keywords: [],
      })),
      { kind: 'setting', id: 'acc', route: '/settings/a', title: 'Accent colour', section: 'S', keywords: [] },
    ]
    expect(searchSettings(index2, 'accent')[0].id).toBe('acc')
  })
})
