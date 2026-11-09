// What the `RemoteExtras` groups share: translation, the data folder and
// error text.

import { getServiceHub } from '@/hooks/useServiceHub'
import { i18n } from '@/i18n/react-i18next-compat'
import { errorText } from '../errorText'

export const t = (key: string, values?: Record<string, unknown>) => i18n.t(key, values) as string

export async function dataFolder(): Promise<string> {
  const folder = await getServiceHub().app().getJanDataFolder()
  if (!folder) throw new Error(t('remote:phone.noDataFolder'))
  return folder
}

export const messageOf = errorText
