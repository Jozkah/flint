import { useMemo, useState } from 'react'
import { Check, Film, LayoutGrid, List, RefreshCw, Trash2 } from 'lucide-react'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useStudio } from '@/hooks/useStudio'
import { cn } from '@/lib/utils'
import { useArchiveEnabled } from '@/hooks/useArchiveEnabled'
import { type GalleryItem, type StudioKind } from '@/lib/studio/studio'
import { PanelButton } from '@/containers/studio/panels/PanelButton'
import { Thumb } from '@/containers/studio/panels/Thumb'
import { ON, rise, timeAgo } from '@/containers/studio/studioHelpers'

/** Your Generations: everything made, filterable, with a select mode to remove several. */
export function GenerationsPanel({
  onOpen,
  onRemix,
}: {
  onOpen: (item: GalleryItem) => void
  onRemix: (item: GalleryItem) => void
}) {
  const { t, i18n } = useTranslation()
  const gallery = useStudio((s) => s.gallery)
  const remove = useStudio((s) => s.remove)
  const archiveOn = useArchiveEnabled()
  const [tab, setTab] = useState<'all' | StudioKind>('all')
  const [layout, setLayout] = useState<'grid' | 'list'>('grid')
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const all = useMemo(
    () =>
      [...gallery.image, ...gallery.video].sort(
        (a, b) => b.recipe.createdAtMs - a.recipe.createdAtMs
      ),
    [gallery]
  )
  const items = tab === 'all' ? all : all.filter((i) => i.kind === tab)

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const leaveSelect = () => {
    setSelecting(false)
    setPicked(new Set())
  }
  const removePicked = async () => {
    // Every picked item, not just the current tab's: the button counts them all.
    for (const item of all) if (picked.has(item.id)) await remove(item.kind, item.id)
    leaveSelect()
  }
  const activate = (item: GalleryItem) => (selecting ? toggle(item.id) : onOpen(item))

  const tabClass = (on: boolean) =>
    cn(
      'inline-flex h-7 items-center rounded-lg px-3 text-xs font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden pointer-coarse:h-11',
      on ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
    )
  const iconBtn = (on: boolean) =>
    cn(
      'grid size-7 place-items-center rounded-md transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden pointer-coarse:size-11',
      on ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
    )

  return (
    <Frame className="motion-safe:animate-rise-in" style={rise(4)}>
      <FrameHeader
        title={t('studio:gens.title')}
        actions={
          <div className="flex items-center gap-2">
            {selecting && (
              <>
                <PanelButton
                  disabled={picked.size === 0}
                  onClick={() => void removePicked()}
                  className="text-destructive"
                >
                  <Trash2 className="size-3" aria-hidden />
                  {archiveOn ? t('studio:gens.archive') : t('studio:actions.delete')} {picked.size > 0 ? picked.size : ''}
                </PanelButton>
              </>
            )}
            <PanelButton onClick={() => (selecting ? leaveSelect() : setSelecting(true))}>
              {selecting ? t('studio:gens.done') : t('studio:gens.select')}
            </PanelButton>
            <div className="flex items-center gap-0.5 rounded-lg border-[0.8px] border-border bg-card p-0.5">
              <button type="button" aria-label={t('studio:gens.grid')} aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')} className={iconBtn(layout === 'grid')}>
                <LayoutGrid className="size-3.5" />
              </button>
              <button type="button" aria-label={t('studio:gens.list')} aria-pressed={layout === 'list'} onClick={() => setLayout('list')} className={iconBtn(layout === 'list')}>
                <List className="size-3.5" />
              </button>
            </div>
          </div>
        }
      />
      <FrameBody className="gap-3 p-3.5">
        <div role="tablist" aria-label={t('studio:gens.filter')} className="flex w-fit items-center gap-1 rounded-xl border-[0.8px] border-border bg-card p-0.5">
          {(
            [
              ['all', t('studio:gens.all')],
              ['image', t('studio:page.images')],
              ['video', t('studio:page.video')],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={tabClass(tab === value)}
            >
              {text}
            </button>
          ))}
        </div>
        {items.length === 0 ? (
          <p className="text-[length:calc(var(--ui-font-base)*0.8125)] text-muted-foreground">
            {t('studio:gens.empty')}
          </p>
        ) : layout === 'grid' ? (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,150px),1fr))] gap-3">
            {items.map((item, i) => {
              const on = picked.has(item.id)
              return (
                <li
                  key={item.id}
                  className={cn(
                    'group relative aspect-[4/3] overflow-hidden rounded-xl border-[0.8px] bg-muted transition-[transform,box-shadow] duration-200 ease-expo hover:-translate-y-0.5 hover:shadow-lift motion-safe:animate-rise-in',
                    on || (i === 0 && !selecting) ? ON : 'border-border'
                  )}
                  style={rise(i)}
                >
                  <button
                    type="button"
                    onClick={() => activate(item)}
                    aria-label={item.recipe.prompt}
                    aria-pressed={selecting ? on : undefined}
                    className="absolute inset-0 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden focus-visible:ring-inset"
                  >
                    <Thumb item={item} />
                  </button>
                  {selecting && (
                    <span
                      aria-hidden
                      className={cn(
                        'pointer-events-none absolute top-2 left-2 grid size-5 place-items-center rounded-md border-[0.8px]',
                        on ? 'border-blue-400 bg-blue-500 text-white' : 'border-white/70 bg-black/40'
                      )}
                    >
                      {on && <Check className="size-3" />}
                    </span>
                  )}
                  {item.kind === 'video' && !selecting && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute top-2 left-2 grid size-6 place-items-center rounded-full bg-black/60 text-white"
                    >
                      <Film className="size-3" />
                    </span>
                  )}
                  {!selecting && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-1.5 bg-gradient-to-t from-black/75 to-transparent p-2 pt-10 text-white opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
                      <p className="line-clamp-2 text-[length:calc(var(--ui-font-base)*0.6875)] leading-snug">{item.recipe.prompt}</p>
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate text-[length:calc(var(--ui-font-base)*0.625)] opacity-80 tabular-nums">
                          {timeAgo(item.recipe.createdAtMs, t, i18n.language)}
                        </span>
                        <span className="pointer-events-auto flex shrink-0 gap-1">
                          <button
                            type="button"
                            title={t('studio:prompt.remix')}
                            aria-label={t('studio:prompt.remixShort')}
                            onClick={() => onRemix(item)}
                            className="grid size-6 place-items-center rounded-md bg-white/15 transition-colors hover:bg-white/30 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-hidden pointer-coarse:size-9"
                          >
                            <RefreshCw className="size-3" />
                          </button>
                          <button
                            type="button"
                            title={archiveOn ? t('studio:actions.archive') : t('studio:actions.delete')}
                            aria-label={archiveOn ? t('studio:actions.archive') : t('studio:actions.delete')}
                            onClick={() => void remove(item.kind, item.id)}
                            className="grid size-6 place-items-center rounded-md bg-white/15 transition-colors hover:bg-white/30 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-hidden pointer-coarse:size-9"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </span>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {items.map((item) => {
              const on = picked.has(item.id)
              return (
                <li
                  key={item.id}
                  className={cn(
                    'flex min-w-0 items-center gap-3 rounded-xl border-[0.8px] p-2',
                    on ? ON : 'border-border'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => activate(item)}
                    aria-pressed={selecting ? on : undefined}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden"
                  >
                    <span className="size-12 shrink-0 overflow-hidden rounded-lg bg-muted">
                      <Thumb item={item} />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-[length:calc(var(--ui-font-base)*0.8125)] text-foreground">{item.recipe.prompt}</span>
                      <span className="truncate text-xs text-muted-foreground tabular-nums">
                        {item.recipe.modelName} · {item.recipe.width} × {item.recipe.height} ·{' '}
                        {timeAgo(item.recipe.createdAtMs, t, i18n.language)}
                      </span>
                    </span>
                  </button>
                  {!selecting && (
                    <button
                      type="button"
                      title={archiveOn ? t('studio:actions.archive') : t('studio:actions.delete')}
                      aria-label={archiveOn ? t('studio:actions.archive') : t('studio:actions.delete')}
                      onClick={() => void remove(item.kind, item.id)}
                      className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden pointer-coarse:size-11"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </FrameBody>
    </Frame>
  )
}
