import { Copy, ExternalLink, Globe, MoreVertical } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { openInBrowser, type BrowserTarget } from '@/lib/browserOpen'

/**
 * The card the transcript shows when the model put a page in front of the
 * user: what it is, where it lives, and a button to open it again. A page on
 * this computer was already opened by the call; any other site waits for the
 * button.
 */
export const BrowserOpenedCard = ({ target }: { target: BrowserTarget }) => {
  const { t } = useTranslation()
  const name = target.title ?? target.origin
  const open = () =>
    void openInBrowser(target.url).catch(() => toast.error(t('chat:browserCard.failed')))
  const copy = () => {
    void navigator.clipboard
      ?.writeText(target.url)
      .then(() => toast.success(t('chat:browserCard.copied')))
      .catch(() => toast.error(t('chat:browserCard.failed')))
  }
  return (
    <div
      data-testid="browser-opened-card"
      className="mb-2 flex w-full max-w-md items-center gap-3 rounded-xl border-[0.8px] border-border bg-card p-2.5 text-foreground"
    >
      <span className="grid size-14 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Globe className="size-6" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={name}>
          {name}
        </div>
        <div className="truncate text-xs text-muted-foreground" title={target.url}>
          {target.origin}
          {target.path}
          {' · '}
          {target.local ? t('chat:browserCard.opened') : t('chat:browserCard.ready')}
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={open} className="gap-1.5">
        <ExternalLink className="size-3.5" aria-hidden />
        {t('chat:browserCard.open')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('chat:browserCard.more')}
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={copy}>
            <Copy className="size-4" />
            {t('chat:browserCard.copy')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
