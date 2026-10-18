/**
 * The llama.cpp engine settings come from the extension's English-only
 * settings.json. Their words are localized at render time from the
 * `engineSettings` namespace, keyed by setting key; English stays the fallback
 * so a setting added later still reads as real copy.
 */
type Translate = (key: string, options?: Record<string, unknown>) => string

/** Providers whose settings are the bundled engine's. */
const ENGINE_PROVIDERS = new Set(['llamacpp'])

/** Settings whose full explanation sits in an info tooltip beside the title. */
export const ENGINE_SETTINGS_WITH_INFO = new Set([
  'ctx_size',
  'fit',
  'fit_target',
  'fit_ctx',
])

export function localizeEngineSetting(
  t: Translate,
  provider: string | undefined,
  setting: ProviderSetting
): ProviderSetting {
  if (!provider || !ENGINE_PROVIDERS.has(provider)) return setting
  const base = `engineSettings:${setting.key}`
  const props: ControllerProps = setting.controller_props ?? {}
  const { options, placeholder } = props
  return {
    ...setting,
    title: t(`${base}.title`, { defaultValue: setting.title }),
    description: setting.description
      ? t(`${base}.description`, { defaultValue: setting.description })
      : setting.description,
    controller_props: {
      ...props,
      ...(options
        ? {
            options: options.map((o) => ({
              ...o,
              name: t(`${base}.options.${String(o.value)}`, {
                defaultValue: o.name,
              }),
            })),
          }
        : {}),
      ...(placeholder && /[a-z]/i.test(placeholder)
        ? {
            placeholder: t(`${base}.placeholder`, {
              defaultValue: placeholder,
            }),
          }
        : {}),
    },
  }
}
