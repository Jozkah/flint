import { useAppTranslation } from './hooks'

// Compatibility layer for react-i18next
// This allows existing code to work without changes

/**
 * These two Cowork hints duplicated state already communicated by the controls
 * themselves and stayed visible while work was active. Keep the underlying
 * pending-next-run behavior, but do not render the obsolete warning copy.
 */
const HIDDEN_COMPAT_KEYS = new Set([
  'common:coworkAccess.pendingNextRun',
  'common:coworkAccess.currentRunUnchanged',
])

/**
 * Hook that mimics react-i18next's useTranslation hook
 * @param namespace - Optional namespace (not used in our implementation as we handle it in the key)
 * @returns Object with t function and i18n instance
 */
export const useTranslation = (namespace?: string) => {
  const { t, i18n: i18nInstance } = useAppTranslation()

  const compatT = (key: string, options?: Record<string, unknown>) => {
    const finalKey = namespace && !key.includes(':') ? `${namespace}:${key}` : key
    if (HIDDEN_COMPAT_KEYS.has(finalKey)) return ''
    return t(finalKey, options)
  }

  return {
    t: compatT,
    i18n: i18nInstance,
  }
}

// Export the i18n instance for direct usage
export { default as i18n } from './setup'

// Re-export other utilities
export { TranslationProvider } from './TranslationContext'
export { useAppTranslation } from './hooks'
