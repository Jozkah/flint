// A stand-in for '@/i18n/react-i18next-compat' for tests that assert the
// words a component shows. Without a provider the real hook returns the key,
// which is what most tests want (they find things by test id); a test that
// reads text mocks the module with this one and gets the English strings.
//
//   vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))
import i18n from '@/i18n/setup'

export const useTranslation = (namespace?: string) => ({
  t: (key: string, options?: Record<string, unknown>) =>
    i18n.t(namespace && !key.includes(':') ? `${namespace}:${key}` : key, options),
  i18n,
})

export { i18n }
