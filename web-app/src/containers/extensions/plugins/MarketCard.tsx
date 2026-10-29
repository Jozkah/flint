import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Frame } from '@/components/ui/frame'
import { ExtensionIcon, extensionIcon } from '@/containers/extensions/ExtensionIcon'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { urlHost, type MarketEntry } from '@/lib/pluginStore'

type Props = {
  entry: MarketEntry
  /** Position in the grid, for the staggered entrance. */
  index: number
  installed: boolean
  installing: boolean
  onInstall: () => void
}

/** A marketplace entry as a card, with its Install button. */
export function MarketCard({
  entry,
  index: i,
  installed,
  installing,
  onInstall,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const { from } = extensionIcon(entry.name)
  return (
    <div role="listitem" className="min-w-0">
      <Frame
        style={{ animationDelay: `${60 + i * 60}ms`, ['--g1' as string]: from }}
        className="group h-full motion-safe:animate-rise-in motion-safe:hover:-translate-y-0.5"
      >
        <div className="relative flex h-[74px] items-start justify-end rounded-t-[9px] border-b-[0.8px] border-border bg-[radial-gradient(circle_at_18%_130%,color-mix(in_oklab,var(--g1)_70%,transparent),transparent_62%),linear-gradient(120deg,color-mix(in_oklab,var(--g1)_38%,transparent),transparent),repeating-linear-gradient(-62deg,transparent_0_10px,rgba(127,127,127,.08)_10px_10.8px)] p-2.5">
          <ExtensionIcon
            name={entry.name}
            size={40}
            className="absolute bottom-[-16px] left-3.5 z-10 shadow-[0_0_0_2.5px_var(--card),0_8px_18px_-8px_color-mix(in_oklab,var(--g1)_70%,transparent)] transition-transform duration-300 ease-expo group-hover:-translate-y-0.5 group-hover:-rotate-4"
          />
        </div>
        <div className="relative flex flex-1 flex-col gap-2.5 rounded-b-[9px] bg-card p-3.5 pt-6">
          <b className="truncate text-sm font-semibold text-foreground">{entry.name}</b>
          <p className="m-0 line-clamp-2 text-[length:calc(var(--ui-font-base)*0.78125)] leading-normal text-muted-foreground">
            {entry.description}
          </p>
          <div className="mt-auto flex items-center justify-between gap-2 text-xs text-subtle-foreground">
            <span className="min-w-0 truncate font-mono" title={entry.repo}>
              {urlHost(entry.repo) || entry.repo}
            </span>
            {entry.marketplace && (
              <span className="min-w-0 truncate" title={entry.marketplace}>
                {entry.clash
                  ? t('plugins:market.clash', { marketplace: urlHost(entry.marketplace) })
                  : urlHost(entry.marketplace)}
              </span>
            )}
            <Button
              size="sm"
              className="h-7 shrink-0 pointer-coarse:h-11"
              disabled={installed || installing}
              onClick={onInstall}
            >
              {installing && (
                <Loader2 className="motion-safe:animate-spin" size={14} aria-hidden />
              )}
              {installed ? t('plugins:state.installed') : t('plugins:install.submit')}
            </Button>
          </div>
        </div>
      </Frame>
    </div>
  )
}
