import { Info, Power, Sparkles, Trash2 } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Chip } from '@/components/ui/chip'
import { Frame } from '@/components/ui/frame'
import { RowMenu } from '@/containers/engine/RowMenu'
import { ExtensionIcon, extensionIcon } from '@/containers/extensions/ExtensionIcon'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { InstalledPlugin } from '@/lib/pluginStore'

export type SurfaceColumn = { key: string; label: string }

type Props = {
  plugin: InstalledPlugin
  /** Position in the grid, for the staggered entrance. */
  index: number
  selected: boolean
  toggling: boolean
  /** Where the plugin is on; null hides the "Enabled on" chips. */
  surfaces: SurfaceColumn[] | null
  isOnSurface: (key: string) => boolean
  /** "Local folder", "Marketplace", ... for a non-git source. */
  sourceLabel: string
  onSelect: () => void
  onToggle: (enabled: boolean) => void
  onRemove: () => void
}

/** One installed plugin as a card: cover, icon tile, what it adds, where it came from. */
export function PluginCard({
  plugin: p,
  index: i,
  selected,
  toggling,
  surfaces,
  isOnSurface,
  sourceLabel,
  onSelect,
  onToggle,
  onRemove,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const { from } = extensionIcon(p.name)
  const counts = [
    p.skills ? t('engine:extensions.skillsCount', { count: p.skills }) : null,
    p.commands ? t('engine:extensions.commandsCount', { count: p.commands }) : null,
    p.agents ? t('engine:extensions.agentsCount', { count: p.agents }) : null,
  ].filter(Boolean)
  return (
    <div role="listitem" className="min-w-0">
      <Frame
        style={{
          animationDelay: `${60 + i * 60}ms`,
          ['--g1' as string]: from,
        }}
        className={cn(
          'group h-full motion-safe:animate-rise-in',
          selected &&
            'shadow-[inset_0_0_0_0.8px_var(--border),0_0_0_1.5px_var(--primary)]'
        )}
      >
        <div
          className={cn(
            'relative flex h-[74px] items-start justify-end rounded-t-[9px] border-b-[0.8px] border-border p-2.5',
            'bg-[radial-gradient(circle_at_18%_130%,color-mix(in_oklab,var(--g1)_70%,transparent),transparent_62%),linear-gradient(120deg,color-mix(in_oklab,var(--g1)_38%,transparent),transparent),repeating-linear-gradient(-62deg,transparent_0_10px,rgba(127,127,127,.08)_10px_10.8px)]'
          )}
        >
          <Switch
            className="relative z-20"
            checked={p.enabled}
            disabled={toggling}
            aria-label={t('plugins:toggle.label', { name: p.name })}
            onCheckedChange={onToggle}
          />
          <ExtensionIcon
            name={p.name}
            size={40}
            className={cn(
              'absolute bottom-[-16px] left-3.5 z-10 shadow-[0_0_0_2.5px_var(--card),0_8px_18px_-8px_color-mix(in_oklab,var(--g1)_70%,transparent)] transition-transform duration-300 ease-expo group-hover:-translate-y-0.5 group-hover:-rotate-4',
              !p.enabled && 'grayscale-[.9]'
            )}
          />
        </div>
        <div className="relative flex flex-1 flex-col gap-2.5 rounded-b-[9px] bg-card p-3.5 pt-6">
          <button
            type="button"
            aria-current={selected ? 'true' : undefined}
            className="flex min-w-0 items-center gap-2 text-left outline-none after:absolute after:inset-0 after:rounded-b-[9px] after:content-[''] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/40"
            onClick={onSelect}
          >
            <b className="truncate text-sm font-semibold text-foreground">
              {p.name}
            </b>
            <Chip mono className="h-5">
              {t('plugins:version', { version: p.version })}
            </Chip>
          </button>
          <p className="m-0 line-clamp-2 text-[length:calc(var(--ui-font-base)*0.78125)] leading-normal text-muted-foreground">
            {p.description || t('plugins:details.noDescription')}
          </p>
          {counts.length > 0 && (
            <span>
              <Chip>
                <Sparkles aria-hidden />
                {counts.join(' · ')}
              </Chip>
            </span>
          )}
          {surfaces && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[length:calc(var(--ui-font-base)*0.6875)] font-medium text-subtle-foreground uppercase">
                {t('common:extensionsManager.enablement.title', undefined) ?? 'Enabled on'}
              </span>
              {surfaces.slice(0, 4).map((c) => {
                const on = isOnSurface(c.key)
                return (
                  <span
                    key={c.key}
                    className={cn(
                      'rounded-full border-[0.8px] px-2 py-0.5 text-[length:calc(var(--ui-font-base)*0.6875)] transition-colors',
                      on
                        ? 'border-transparent bg-[color-mix(in_oklab,var(--success)_14%,transparent)] text-success'
                        : 'border-dashed border-border-strong text-subtle-foreground'
                    )}
                  >
                    {c.label}
                  </span>
                )
              })}
              {surfaces.length > 4 && (
                <span className="text-[length:calc(var(--ui-font-base)*0.6875)] text-subtle-foreground">
                  +{surfaces.length - 4}
                </span>
              )}
            </div>
          )}
          <div className="relative z-10 mt-auto flex items-center justify-between gap-2 text-xs text-subtle-foreground">
            <span className="min-w-0 truncate font-mono" title={p.source ?? undefined}>
              {/* A repository reads best as its address; a folder or a
                  marketplace name by what kind of source it is (the full
                  path is in the tooltip and the details). */}
              {p.sourceKind === 'git' && p.source
                ? p.source.replace(/^https?:\/\//, '')
                : sourceLabel}
            </span>
            <RowMenu
              label={t('engine:extensions.pluginActions', { name: p.name })}
              items={[
                {
                  label: t('engine:extensions.details'),
                  icon: <Info />,
                  onSelect,
                },
                {
                  label: p.enabled
                    ? t('engine:extensions.disable')
                    : t('engine:extensions.enable'),
                  icon: <Power />,
                  disabled: toggling,
                  onSelect: () => onToggle(!p.enabled),
                },
                'separator',
                {
                  label: t('plugins:remove.button'),
                  icon: <Trash2 />,
                  destructive: true,
                  onSelect: onRemove,
                },
              ]}
            />
          </div>
        </div>
      </Frame>
    </div>
  )
}
