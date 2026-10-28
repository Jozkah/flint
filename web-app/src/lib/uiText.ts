import { i18n } from '@/i18n/react-i18next-compat'

/**
 * A user-facing sentence from the locale files, with the English text as the
 * fallback when i18n is not ready (tests, early startup) or has no entry.
 */
export function uiText(
  key: string,
  english: string,
  values?: Record<string, unknown>
): string {
  try {
    const out = i18n.t(key, {
      defaultValue: english,
      interpolation: { escapeValue: false },
      ...values,
    }) as unknown
    if (typeof out === 'string' && out && out !== key) return out
  } catch {
    // fall through to English
  }
  return english.replace(/\{\{(\w+)\}\}/g, (m, name: string) =>
    values && name in values ? String(values[name]) : m
  )
}
