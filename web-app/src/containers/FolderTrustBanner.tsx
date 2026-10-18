import { InfoIcon, ShieldCheckIcon, ShieldQuestionIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BarRow } from '@/components/ui/bar-row'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useFolderTrust } from '@/hooks/useFolderTrust'
import { carriesKind } from '@/lib/folderTrust'

/**
 * Asks once whether a folder that carries its own hooks or agent definitions
 * may run them. They are off until the person says yes, and a yes is for good.
 * Renders nothing for a folder with nothing to ask about.
 *
 * Pinned above the composer (the Cowork bar stack, the chat composer's
 * wrapper), like the other bars, so it stays in view while the transcript
 * scrolls. One row: a one-line summary, the full explanation behind the info
 * button, and "Trust folder" kept in view while "Not now" shrinks to an x.
 */
export function FolderTrustBanner({ folder }: { folder: string | null }) {
  const { t } = useTranslation()
  const { status, ask, trust, later } = useFolderTrust(folder)
  if (!ask || !status || !folder) return null
  const kind = carriesKind(status.carries)
  const body =
    kind === 'both'
      ? 'permissions:folderTrust.bodyBoth'
      : kind === 'hooks'
        ? 'permissions:folderTrust.bodyHooks'
        : 'permissions:folderTrust.bodySubagents'
  const summary =
    kind === 'both'
      ? 'permissions:folderTrust.summaryBoth'
      : kind === 'hooks'
        ? 'permissions:folderTrust.summaryHooks'
        : 'permissions:folderTrust.summarySubagents'
  return (
    <section
      role="region"
      aria-label={t('permissions:folderTrust.title')}
      data-testid="folder-trust-banner"
      className="mb-1.5 w-full min-w-0"
    >
      <BarRow
        className="border border-warning/50 bg-warning-tint"
        icon={
          <ShieldQuestionIcon aria-hidden className="size-4 shrink-0 text-warning" />
        }
        lead={t(summary)}
        leadTitle={t(body, { folder })}
        leadClassName="font-medium text-foreground"
        leadTestId="folder-trust-summary"
        meta={
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t('permissions:folderTrust.details')}
                data-testid="folder-trust-info"
                className="shrink-0 pointer-coarse:size-11"
              >
                <InfoIcon className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-80 space-y-2 text-sm"
              data-testid="folder-trust-details"
            >
              <p className="font-medium text-foreground">
                {t('permissions:folderTrust.title')}
              </p>
              <p className="wrap-break-word text-foreground">{t(body, { folder })}</p>
              <p className="text-xs text-muted-foreground">
                {t('permissions:folderTrust.keepsOff')}
              </p>
            </PopoverContent>
          </Popover>
        }
        actions={[
          {
            id: 'later',
            label: t('permissions:folderTrust.later'),
            icon: <X className="size-4" />,
            iconOnlyCollapsed: true,
            onSelect: later,
            testId: 'folder-trust-later',
            floor: 'icon',
          },
          {
            id: 'trust',
            label: t('permissions:folderTrust.trust'),
            onSelect: () => void trust(),
            testId: 'folder-trust-grant',
            variant: 'default',
            icon: <ShieldCheckIcon className="size-4" />,
            iconOnlyCollapsed: true,
            rank: 1,
            // Its label goes only once nothing else is left to give up.
            floor: 'icon',
          },
        ]}
      />
    </section>
  )
}
