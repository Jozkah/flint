/**
 * A short date ("Aug 20, 2026") in the UI language. `toLocaleDateString` with
 * no locale follows the system, so the hub kept English dates after the app
 * was switched to Japanese (T7-092).
 */
const INTL_LOCALE: Record<string, string> = { vn: 'vi' }

export function formatShortDate(
  value: string | number | null | undefined,
  language: string | undefined
): string | null {
  const time = typeof value === 'number' ? value : Date.parse(value ?? '')
  if (Number.isNaN(time)) return null
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
  const lang = language ? (INTL_LOCALE[language] ?? language) : undefined
  try {
    return new Date(time).toLocaleDateString(lang, opts)
  } catch {
    return new Date(time).toLocaleDateString(undefined, opts)
  }
}
