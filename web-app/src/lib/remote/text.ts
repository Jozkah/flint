import { i18n } from '@/i18n/react-i18next-compat'

/** Text the phone shows that the desktop writes (`remote:phone.*`). */
export const pt = (key: string, values?: Record<string, unknown>): string =>
  i18n.t(`remote:phone.${key}`, values) as string
