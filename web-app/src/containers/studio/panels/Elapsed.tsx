import { useSecondClock } from '@/lib/sharedClock'
import { useTranslation } from '@/i18n/react-i18next-compat'

/** Time spent waiting on a hosted job, ticking each second, so a slow render shows it is alive. */
export function Elapsed({ since }: { since: number }) {
  const { t } = useTranslation()
  const now = useSecondClock()
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return (
    <>
      {' · '}
      {text}
      {seconds >= 300 ? ` · ${t('studio:elapsed.slow')}` : ''}
    </>
  )
}
