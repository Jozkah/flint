import { i18n } from '@/i18n/react-i18next-compat'

/** An amount in dollars, written the way the app's language writes money. */
const money = (usd: number) =>
  new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  }).format(usd)

/**
 * The run's spend-pause question in the app's language. The backend sends it
 * as one English sentence ("Continue the run up to its $5.00 ceiling (about
 * $2.10 spent so far)"); the amounts are read back out of it and formatted
 * here. `undefined` when they cannot be found, so the caller shows the
 * sentence as it came.
 */
export function describeSpendPause(command: string | undefined): string | undefined {
  const spent = command?.match(/about \$(\d+(?:\.\d+)?) spent/)?.[1]
  if (spent === undefined) return undefined
  const ceiling = command?.match(/\$(\d+(?:\.\d+)?) ceiling/)?.[1]
  return ceiling === undefined
    ? i18n.t('permissions:spendPause.preview', { spent: money(Number(spent)) })
    : i18n.t('permissions:spendPause.previewCeiling', {
        spent: money(Number(spent)),
        ceiling: money(Number(ceiling)),
      })
}
