import { useEffect, useMemo, useRef, useState } from 'react'
import { useAssetUrl } from '@/lib/assetPath'
import { Film, ImageIcon, Loader, X } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Segmented } from '@/components/ui/segmented'
import { ImageViewer, type ViewerImage } from '@/components/ImageViewer'
import { EnginePage, PageHead } from '@/containers/engine/EngineKit'
import { useStudio } from '@/hooks/useStudio'
import { IMAGE_SIZES, VIDEO_SIZES, sizeIndexOf } from '@/lib/studio/helpers'
import { type GalleryItem, type StudioKind } from '@/lib/studio/studio'
import { ActivityPanel } from '@/containers/studio/panels/ActivityPanel'
import { EngineSetup } from '@/containers/studio/panels/EngineSetup'
import { GenerationsPanel } from '@/containers/studio/panels/GenerationsPanel'
import { ModelPanel } from '@/containers/studio/panels/ModelPanel'
import { PromptPanel } from '@/containers/studio/panels/PromptPanel'
import { SettingsPanel } from '@/containers/studio/panels/SettingsPanel'
import { VideoDialog } from '@/containers/studio/panels/VideoDialog'
import { useCloudTargets } from '@/containers/studio/studioHelpers'
import { CUSTOM, EMPTY_FORM, Form } from '@/containers/studio/studioTypes'

// The artifacts route opens videos with the same dialog.
export { VideoDialog }

export function StudioPage() {
  const { t } = useTranslation()
  const convertFileSrc = useAssetUrl()
  const status = useStudio((s) => s.status)
  const error = useStudio((s) => s.error)
  const refresh = useStudio((s) => s.refresh)
  const refreshGallery = useStudio((s) => s.refreshGallery)
  const clearError = useStudio((s) => s.clearError)
  const gallery = useStudio((s) => s.gallery)
  const [kind, setKind] = useState<StudioKind>('image')
  const [form, setFormState] = useState<Form>(EMPTY_FORM)
  const [viewing, setViewing] = useState<number | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const targets = useCloudTargets(kind)

  // A hosted model whose provider lost its key must not come back selected, and
  // billed, when the key is added again.
  useEffect(() => {
    if (form.cloud && !targets.some((t) => t.key === form.cloud)) {
      setFormState((f) => ({ ...f, cloud: '' }))
    }
  }, [form.cloud, targets])

  const setForm = (patch: Partial<Form>) =>
    setFormState((f) => ({ ...f, ...patch }))

  useEffect(() => {
    void refresh()
    void refreshGallery('image')
    void refreshGallery('video')
  }, [refresh, refreshGallery])

  const model = useMemo(() => {
    const ofKind = status?.models.filter((m) => m.kind === kind) ?? []
    return ofKind.find((m) => m.id === form.localModel) ?? ofKind[0]
  }, [status, kind, form.localModel])

  // The sizes differ between images and video, so the chosen shape starts over.
  const changeKind = (next: StudioKind) => {
    setViewing(null)
    setKind(next)
    setForm({
      sizeIndex: form.sizeIndex === CUSTOM ? CUSTOM : 0,
      cloud: '',
      localModel: '',
      loras: [],
    })
  }

  const remix = (item: GalleryItem) => {
    const sizes = item.kind === 'video' ? VIDEO_SIZES : IMAGE_SIZES
    setForm({
      prompt: item.recipe.prompt,
      negative: item.recipe.negativePrompt,
      seed: '',
      cloud: targets.some((t) => t.key === item.recipe.modelId)
        ? item.recipe.modelId
        : '',
      localModel: status?.models.some((m) => m.id === item.recipe.modelId)
        ? item.recipe.modelId
        : '',
      loras: item.recipe.lora ?? [],
      // The exact size it was made at: a standard shape when it is one,
      // else the custom boxes, so a remix never quietly changes the size.
      ...(sizes.some(
        (s) => s.width === item.recipe.width && s.height === item.recipe.height
      )
        ? {
            sizeIndex: sizeIndexOf(
              sizes,
              item.recipe.width,
              item.recipe.height
            ),
          }
        : {
            sizeIndex: CUSTOM,
            customWidth: String(item.recipe.width),
            customHeight: String(item.recipe.height),
          }),
    })
    promptRef.current?.focus()
    promptRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  // The list under the studio shows both kinds; opening or remixing one of the
  // other kind switches to it first.
  const openItem = (item: GalleryItem) => {
    if (item.kind !== kind) changeKind(item.kind)
    setViewing(gallery[item.kind].findIndex((g) => g.id === item.id))
  }
  const remixAny = (item: GalleryItem) => {
    if (item.kind !== kind) changeKind(item.kind)
    remix(item)
  }

  // Pictures open in the same viewer the chat uses; a video has its own dialog.
  const shown = gallery[kind]
  const viewerImages = useMemo<ViewerImage[]>(
    () =>
      kind === 'image'
        ? shown.map((g) => ({
            url: convertFileSrc(g.path),
            name: `studio-${g.recipe.seed}`,
          }))
        : [],
    [shown, kind, convertFileSrc]
  )

  // A hosted model runs on the provider's machines: the local engine is not
  // needed for it, and the prompt does leave this computer.
  const usingHosted = !!form.cloud && targets.some((t) => t.key === form.cloud)

  return (
    <EnginePage testId="studio-page">
      <PageHead
        title={t('studio:page.title')}
        description={
          usingHosted
            ? t('studio:page.descriptionHosted')
            : t('studio:page.descriptionLocal')
        }
        actions={
          <Segmented<StudioKind>
            aria-label={t('studio:page.whatToMake')}
            className="min-w-[200px]"
            options={[
              { value: 'image', label: t('studio:page.images'), icon: <ImageIcon className="size-4" /> },
              { value: 'video', label: t('studio:page.video'), icon: <Film className="size-4" /> },
            ]}
            value={kind}
            onValueChange={changeKind}
          />
        }
      />
      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-lg border-[0.8px] border-destructive/30 bg-destructive/5 p-3 text-[length:calc(var(--ui-font-base)*0.8125)] motion-safe:animate-rise-in"
        >
          <span className="min-w-0 break-words">{error}</span>
          <button
            type="button"
            aria-label={t('studio:page.dismiss')}
            onClick={clearError}
            className="shrink-0 rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      {!status ? (
        <div className="flex items-center gap-2 text-[length:calc(var(--ui-font-base)*0.8125)] text-muted-foreground">
          <Loader className="size-4 animate-spin" /> {t('studio:page.loading')}
        </div>
      ) : (
        <>
          {!usingHosted && <EngineSetup />}
          {(status.supported || usingHosted) && model && (
            <div className="grid gap-4 lg:grid-cols-[minmax(300px,1.1fr)_minmax(0,1.35fr)_minmax(260px,1fr)] lg:items-stretch">
              <div className="flex min-w-0 flex-col gap-4">
                <ModelPanel
                  kind={kind}
                  model={model}
                  form={form}
                  setForm={setForm}
                  targets={targets}
                />
                <SettingsPanel
                  kind={kind}
                  model={model}
                  form={form}
                  setForm={setForm}
                  targets={targets}
                />
              </div>
              <PromptPanel
                kind={kind}
                model={model}
                form={form}
                setForm={setForm}
                promptRef={promptRef}
                onOpen={setViewing}
                targets={targets}
                onRemix={remix}
              />
              <ActivityPanel kind={kind} onOpen={setViewing} onRemix={remix} />
            </div>
          )}
          <GenerationsPanel onOpen={openItem} onRemix={remixAny} />
        </>
      )}
      {kind === 'image' && viewing !== null && viewerImages[viewing] && (
        <ImageViewer
          images={viewerImages}
          index={viewing}
          onIndexChange={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
      <VideoDialog
        item={
          kind === 'video' && viewing !== null ? (shown[viewing] ?? null) : null
        }
        onClose={() => setViewing(null)}
      />
    </EnginePage>
  )
}
