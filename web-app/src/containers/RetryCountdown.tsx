// "Retrying in Ns" for a Hugging Face download waiting out a dropped
// connection. The wait comes from the backend (retryInMs on the progress
// event); this only counts it down.

import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'

/** Whole seconds left until `retryAt`, never below zero. */
export function retrySecondsLeft(retryAt: number, now: number): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000))
}

export function RetryCountdown({
  retryAt,
  className,
}: {
  retryAt: number
  className?: string
}) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [retryAt])
  const seconds = retrySecondsLeft(retryAt, now)
  return (
    <span className={className} role="status">
      {seconds > 0
        ? t('sweep:hub.retryingIn', { seconds })
        : t('sweep:hub.retryingNow')}
    </span>
  )
}
