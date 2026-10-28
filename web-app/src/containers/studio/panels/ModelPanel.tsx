import { useMemo, useState } from 'react'
import { Box, Download, Film, ImageIcon } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Progress } from '@/components/ui/progress'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useStudio } from '@/hooks/useStudio'
import { type CloudTarget } from '@/lib/studio/cloud'
import { formatModelBytes } from '@/lib/huggingface'
import { type StudioKind, type StudioModel } from '@/lib/studio/studio'
import { EnginePicker } from '@/containers/studio/panels/EnginePicker'
import { PanelButton } from '@/containers/studio/panels/PanelButton'
import { modelTint, rise } from '@/containers/studio/studioHelpers'
import { Form } from '@/containers/studio/studioTypes'

/** Model: what is picked, whether it is ready, and the one button to get it ready. */
export function ModelPanel({
  kind,
  model,
  form,
  setForm,
  targets,
}: {
  kind: StudioKind
  model: StudioModel
  form: Form
  setForm: (patch: Partial<Form>) => void
  targets: CloudTarget[]
}) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const status = useStudio((s) => s.status)
  const download = useStudio((s) => s.download)
  const job = useStudio((s) => s.job)
  const downloadModel = useStudio((s) => s.downloadModel)
  const load = useStudio((s) => s.load)
  const unload = useStudio((s) => s.unload)
  const removeCustomModel = useStudio((s) => s.removeCustomModel)
  const allModels = useStudio((s) => s.status?.models)
  const localModels = useMemo(
    () => allModels?.filter((m) => m.kind === kind) ?? [],
    [allModels, kind]
  )
  const [loading, setLoading] = useState(false)
  const hosted = targets.find((t) => t.key === form.cloud)
  const resident = status?.resident?.model_id === model.id
  const downloading = download?.modelId === model.id
  const percent =
    downloading && download.total
      ? Math.round((download.bytes / download.total) * 100)
      : 0
  const engineReady = !!status?.engineBackend
  const running = !!job
  const name = hosted ? hosted.model.name : model.display_name
  const noun = kind === 'video' ? t('studio:model.textToVideo') : t('studio:model.textToImage')

  return (
    <Frame className="motion-safe:animate-rise-in" style={rise(0)}>
      <FrameHeader
        icon={<Box className="size-4" aria-hidden />}
        title={t('studio:model.title')}
        actions={
          <PanelButton onClick={() => navigate({ to: route.hub.index })}>
            {t('studio:model.manage')}
          </PanelButton>
        }
      />
      <FrameBody className="gap-3 p-3.5">
        <div className="flex gap-3.5">
          <div
            aria-hidden
            className="grid size-20 shrink-0 place-items-center rounded-xl text-white/80"
            style={{ background: modelTint(hosted ? hosted.key : model.id) }}
          >
            {kind === 'video' ? <Film className="size-7" /> : <ImageIcon className="size-7" />}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <EnginePicker
              disabled={running}
              value={hosted ? `cloud:${form.cloud}` : `local:${model.id}`}
              label={name}
              modelId={hosted ? hosted.model.name : model.id}
              providerId={hosted?.provider.provider}
              local={localModels.map((m) => ({ id: m.id, name: m.display_name }))}
              hosted={targets.map((t) => ({
                key: t.key,
                name: t.model.name,
                provider: t.provider.label,
                providerId: t.provider.provider,
              }))}
              onLocal={(id) => setForm({ cloud: '', localModel: id })}
              onHosted={(key) => setForm({ cloud: key })}
            />
            {hosted ? (
              <Chip tone="info" dot>
                {t('studio:model.hostedBy', { provider: hosted.provider.label })}
              </Chip>
            ) : (
              <Chip tone={resident ? 'ok' : 'neutral'} dot>
                {resident ? t('studio:model.loaded') : model.installed ? t('studio:model.ready') : t('studio:model.notDownloaded')}
              </Chip>
            )}
            <p className="text-xs leading-snug text-muted-foreground">
              {hosted
                ? t('studio:model.hostedNote', { provider: hosted.provider.label })
                : t('studio:model.localNote', {
                    width: model.defaults.width,
                    height: model.defaults.height,
                    count: model.defaults.steps,
                  })}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {!hosted && (
            <>
              <Chip mono>{formatModelBytes(model.totalBytes)}</Chip>
              <Chip mono>{model.license}</Chip>
            </>
          )}
          <Chip mono>{noun}</Chip>
        </div>
        {!hosted && downloading && (
          <div className="space-y-1.5">
            <Progress value={percent} />
            <p className="text-xs text-muted-foreground">
              {download.bytes <= 0
                ? download.total > 0
                  ? t('studio:download.startingSize', { size: formatModelBytes(download.total) })
                  : t('studio:download.starting')
                : download.total > 0
                  ? t('studio:download.progress', {
                      bytes: formatModelBytes(download.bytes),
                      total: formatModelBytes(download.total),
                    })
                  : formatModelBytes(download.bytes)}
            </p>
          </div>
        )}
        {!hosted &&
          (!model.installed ? (
            <Button size="sm" disabled={downloading} onClick={() => void downloadModel(model)}>
              <Download className="size-3.5" />
              {downloading ? t('studio:download.downloading') : t('studio:download.button', { size: formatModelBytes(model.totalBytes) })}
            </Button>
          ) : resident ? (
            <Button size="sm" variant="outline" disabled={!!job} onClick={() => void unload()}>
              {t('studio:model.unload')}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!engineReady || loading || !!job}
              onClick={async () => {
                setLoading(true)
                await load(model.id)
                setLoading(false)
              }}
            >
              {loading ? t('studio:model.loading') : t('studio:model.load')}
            </Button>
          ))}
        {!hosted && !engineReady && model.installed && (
          <p className="text-xs text-muted-foreground">
            {t('studio:model.installFirst')}
          </p>
        )}
        {!hosted && model.custom && (
          <button
            type="button"
            disabled={!!job || resident}
            onClick={async () => {
              await removeCustomModel(model.id)
              setForm({ localModel: '' })
            }}
            title={t('studio:model.removeTitle')}
            className="self-start rounded-md text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
          >
            {t('studio:model.remove')}
          </button>
        )}
      </FrameBody>
    </Frame>
  )
}
