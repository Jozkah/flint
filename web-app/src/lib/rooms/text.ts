import { i18n } from '@/i18n/react-i18next-compat'

/** A room note, error or notice in the interface language (`rooms:notes.*`). */
export const rt = (key: string, values?: Record<string, unknown>): string =>
  i18n.t(`rooms:notes.${key}`, values) as string
