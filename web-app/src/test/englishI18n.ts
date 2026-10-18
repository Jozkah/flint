// A stand-in for '@/i18n/react-i18next-compat' for tests that assert the
// words a component shows. Without a provider the real hook returns the key,
// which is what most tests want (they find things by test id); a test that
// reads text mocks the module with this one and gets the English strings.
//
//   vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))
import i18n from '@/i18n/setup'

// One `t` (and one result object) per namespace, as the real hook gives: a
// component that lists `t` in an effect's dependencies must not re-run it on
// every render.
const hooks = new Map<string | undefined, { t: (key: string, options?: Record<string, unknown>) => string; i18n: typeof i18n }>()

export const useTranslation = (namespace?: string) => {
  let hook = hooks.get(namespace)
  if (!hook) {
    hook = {
      t: (key: string, options?: Record<string, unknown>) =>
        i18n.t(namespace && !key.includes(':') ? `${namespace}:${key}` : key, options) as string,
      i18n,
    }
    hooks.set(namespace, hook)
  }
  return hook
}

export { i18n }
