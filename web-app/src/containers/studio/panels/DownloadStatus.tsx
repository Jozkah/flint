import { useState } from 'react'
import { AlertTriangle, Check, Copy, RotateCcw } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { RetryCountdown } from '@/containers/RetryCountdown'
import { PanelButton } from '@/containers/studio/panels/PanelButton'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useStudio } from '@/hooks/useStudio'
import { copyToClipboard } from '@/lib/clipboard'
import { formatModelBytes } from '@/lib/huggingface'
import { downloadProgressText } from '@/lib/studio/helpers'
import { type StudioDownloadFailure, type StudioModel } from '@/lib/studio/studio'

/** A copy button that says "Copied" for a moment, so the click is seen to work. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <PanelButton
      disabled={!text}
      aria-live="polite"
      onClick={async () => {
        if (!(await copyToClipboard(text))) return
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      {copied ? t('studio:download.copied') : label}
    </PanelButton>
  )
}

function FailedFile({ file, count }: { file: StudioDownloadFailure; count: number }) {
  const { t } = useTranslation()
  return (
    <li className="space-y-1.5 border-t-[0.8px] border-border pt-2.5 first:border-t-0 first:pt-0">
      <p translate="no" className="text-xs font-medium break-all">
        {count > 1 ? `${file.index + 1}/${count} · ` : ''}
        {t('studio:download.failedFile', {
          name: file.filename,
          size: formatModelBytes(file.size),
          repo: file.repo,
        })}
      </p>
      <p className="text-xs break-words text-muted-foreground">{file.error}</p>
      <div className="flex flex-wrap gap-1.5">
        <CopyButton text={file.url} label={t('studio:download.copyLink')} />
        <CopyButton text={file.path} label={t('studio:download.copyPath')} />
      </div>
    </li>
  )
}

/**
 * What a model download is doing: the file coming down (name, source, bytes),
 * a wait after a failed attempt with its reason, and, once it gave up, which
 * files failed and why, with a way to try again or fetch them by hand.
 */
export function DownloadStatus({ model }: { model: StudioModel }) {
  const { t } = useTranslation()
  const download = useStudio((s) => s.download)
  const failure = useStudio((s) => s.downloadFailure)
  const downloadModel = useStudio((s) => s.downloadModel)

  if (download?.modelId === model.id) {
    const file = model.files[download.fileIndex]
    const percent = download.total ? Math.round((download.bytes / download.total) * 100) : 0
    return (
      <div className="space-y-1.5">
        <Progress value={percent} />
        <p className="text-xs text-muted-foreground tabular-nums">
          {downloadProgressText(download.bytes, download.total, formatModelBytes)}
        </p>
        {file && (
          <p translate="no" className="text-xs break-all text-muted-foreground">
            {t('studio:download.file', {
              index: download.fileIndex + 1,
              count: model.files.length,
              name: file.filename,
            })}
            <span className="block">{t('studio:download.source', { repo: file.repo, size: formatModelBytes(file.size) })}</span>
          </p>
        )}
        {download.retry && (
          <p className="text-xs break-words text-warning tabular-nums">
            {t('studio:download.waiting', { reason: download.retry.reason })}{' '}
            <RetryCountdown retryAt={download.retry.at} />
          </p>
        )}
      </div>
    )
  }

  if (failure?.modelId !== model.id || model.installed) return null
  return (
    <div role="alert" className="space-y-2.5 rounded-lg border-[0.8px] border-destructive/30 bg-destructive/5 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <AlertTriangle className="size-3.5 shrink-0 text-destructive" aria-hidden />
        {t('studio:download.failedTitle')}
      </p>
      <ul className="space-y-2.5">
        {failure.files.map((file) => (
          <FailedFile key={file.index} file={file} count={model.files.length} />
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t('studio:download.manualHint')}</p>
      <PanelButton onClick={() => void downloadModel(model)}>
        <RotateCcw className="size-3.5" aria-hidden />
        {t('studio:download.retry')}
      </PanelButton>
    </div>
  )
}
