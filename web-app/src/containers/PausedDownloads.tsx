// Hugging Face downloads that are paused or failed, listed at the top of
// Discover. A download only has a row on its own model's card, so after a
// relaunch brings one back (lib/restoreInterruptedDownloads) this is where it
// can be found and resumed without searching for the model again.

import { useMemo } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Pause, Play, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  cancelHuggingFaceBundle,
  pauseHuggingFaceBundle,
  resumeHuggingFaceBundle,
  retryHuggingFaceBundle,
  useHuggingFaceDownloads,
} from '@/hooks/useHuggingFaceDownloads'
import { formatModelBytes } from '@/lib/huggingface'
import { RetryCountdown } from '@/containers/RetryCountdown'

export function PausedDownloads() {
  const { t } = useTranslation()
  const tasks = useHuggingFaceDownloads((state) => state.tasks)
  const stopped = useMemo(
    () =>
      Object.values(tasks)
        .filter(
          (task) =>
            task.status === 'paused' ||
            task.status === 'error' ||
            // Waiting out a dropped connection: stuck until it comes back.
            (task.status === 'downloading' && task.retryAt !== undefined)
        )
        .sort((a, b) => a.label.localeCompare(b.label)),
    [tasks]
  )
  if (stopped.length === 0) return null

  return (
    <section
      aria-label={t('sweep:hub.pausedDownloads')}
      className="mb-4 rounded-lg border border-border bg-card"
    >
      <h2 className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
        {t('sweep:hub.pausedDownloads')}
      </h2>
      <ul className="divide-y divide-border">
        {stopped.map((task) => (
          <li key={task.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm" title={task.repo}>
                {task.label}
              </div>
              <div
                className="truncate text-xs text-muted-foreground"
                title={task.error}
              >
                {task.status === 'downloading' && task.retryAt !== undefined
                  ? <RetryCountdown retryAt={task.retryAt} />
                  : task.status === 'error'
                  ? task.error
                    ? t('sweep:hub.downloadFailedWith', { error: task.error })
                    : t('sweep:hub.downloadFailed')
                  : `${Math.round(task.progress * 100)}%${
                      task.total ? ` · ${formatModelBytes(task.total)}` : ''
                    }`}
              </div>
            </div>
            {task.status === 'downloading' ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void pauseHuggingFaceBundle(task.id)}
              >
                <Pause className="size-3.5" /> {t('common:a11y.pauseDownload')}
              </Button>
            ) : task.status === 'error' ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void retryHuggingFaceBundle(task.id)}
              >
                <RotateCcw className="size-3.5" /> {t('sweep:hub.retry')}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void resumeHuggingFaceBundle(task.id)}
              >
                <Play className="size-3.5" /> {t('sweep:hub.resume')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => void cancelHuggingFaceBundle(task.id)}
              title={t('common:a11y.cancelDownload')}
              aria-label={t('common:a11y.cancelDownload')}
            >
              <X className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
