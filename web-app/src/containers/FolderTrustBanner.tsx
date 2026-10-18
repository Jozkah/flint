import { ShieldQuestionIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
 * scrolls.
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
  return (
    <section
      role="region"
      aria-label={t('permissions:folderTrust.title')}
      data-testid="folder-trust-banner"
      className="mb-1.5 flex w-full min-w-0 flex-col gap-2 rounded-xl border border-warning/40 bg-card p-3 text-[length:calc(var(--ui-font-base)*0.8125)] sm:p-3.5"
    >
      <div className="flex min-w-0 items-center gap-2 font-medium text-foreground">
        <ShieldQuestionIcon aria-hidden className="size-4 shrink-0 text-warning" />
        {t('permissions:folderTrust.title')}
      </div>
      <p className="min-w-0 wrap-break-word text-foreground">
        {t(body, { folder })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t('permissions:folderTrust.keepsOff')}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={later}>
          {t('permissions:folderTrust.later')}
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="folder-trust-grant"
          onClick={() => void trust()}
        >
          {t('permissions:folderTrust.trust')}
        </Button>
      </div>
    </section>
  )
}
