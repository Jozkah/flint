import { useCallback, useMemo } from 'react'
import { useAppTranslation } from './hooks'

// Compatibility layer for react-i18next
// This allows existing code to work without changes

/**
 * Hook that mimics react-i18next's useTranslation hook
 * @param namespace - Optional namespace (not used in our implementation as we handle it in the key)
 * @returns Object with t function and i18n instance
 */
export const useTranslation = (namespace?: string) => {
  const { t, i18n: i18nInstance } = useAppTranslation()

  // Stable identity: effects and memos that list `t` in their deps must not
  // re-run on every render.
  const compatT = useCallback(
    (key: string, options?: Record<string, unknown>) => {
      const finalKey =
        namespace && !key.includes(':') ? `${namespace}:${key}` : key
      return t(finalKey, options)
    },
    [t, namespace]
  )

  return useMemo(
    () => ({
      t: compatT,
      i18n: i18nInstance,
    }),
    [compatT, i18nInstance]
  )
}

// Export the i18n instance for direct usage
export { default as i18n } from './setup'

// Re-export other utilities
export { TranslationProvider } from './TranslationContext'
export { useAppTranslation } from './hooks'
