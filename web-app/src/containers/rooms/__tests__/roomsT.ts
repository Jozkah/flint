// Only JSON in here: the i18n mocks in the rooms tests await this file, so it
// must not import anything that reaches `@/i18n/react-i18next-compat` (the
// engine's text helper does), or the mock factory waits on itself and the
// test hangs.
import rooms from '@/locales/en/rooms.json'
import uiLeftovers from '@/locales/en/uiLeftovers.json'

/** Real `rooms` strings with `{{var}}` interpolation, so tests read like the UI. */
export function t(key: string, options: Record<string, unknown> = {}): string {
  const [ns, path] = key.includes(':') ? key.split(':') : ['common', key]
  const table = ns === 'rooms' ? rooms : ns === 'uiLeftovers' ? uiLeftovers : null
  if (!table) return key
  const value = path
    .split('.')
    .reduce<unknown>((cur, part) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined), table)
  if (typeof value !== 'string') return key
  return value.replace(/\{\{(\w+)\}\}/g, (m, v) => (options[v] !== undefined ? String(options[v]) : m))
}
