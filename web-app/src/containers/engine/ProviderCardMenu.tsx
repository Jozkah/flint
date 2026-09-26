import { MoreHorizontal, Pencil, Power, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { providerMenuActions } from '@/hooks/useRemoveProvider'
import { cn } from '@/lib/utils'

/**
 * The "⋯" menu of a provider card. The card's right-click (and the
 * ContextMenu / Shift+F10 keys) open the same menu through `open`.
 */
export function ProviderCardMenu({
  provider,
  title,
  open,
  onOpenChange,
  onEdit,
  onToggle,
  onRemove,
  className,
}: {
  provider: ProviderObject
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onEdit: () => void
  onToggle: () => void
  onRemove: () => void
  className?: string
}) {
  const { t } = useTranslation()
  const actions = providerMenuActions(provider.provider)
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('providers:cardMenu.actions', { provider: title })}
          title={t('providers:cardMenu.actions', { provider: title })}
          className={cn(
            'relative z-10 text-muted-foreground pointer-coarse:size-11',
            className
          )}
        >
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {actions.includes('edit') && (
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil />
            {t('providers:cardMenu.edit')}
          </DropdownMenuItem>
        )}
        {actions.includes('toggle') && (
          <DropdownMenuItem onSelect={onToggle}>
            <Power />
            {provider.active
              ? t('providers:cardMenu.disable')
              : t('providers:cardMenu.enable')}
          </DropdownMenuItem>
        )}
        {actions.includes('remove') && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 />
              {t('providers:cardMenu.remove')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Confirms removing a provider, naming it and how many models go with it. */
export function RemoveProviderDialog({
  provider,
  title,
  onOpenChange,
  onConfirm,
}: {
  provider: ProviderObject | null
  title: string
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={!!provider} onOpenChange={onOpenChange}>
      <DialogContent data-testid="remove-provider-dialog">
        <DialogHeader>
          <DialogTitle>
            {t('providers:removeProvider.confirmTitle', { provider: title })}
          </DialogTitle>
          <DialogDescription>
            {t('providers:removeProvider.confirmDescription', {
              provider: title,
              count: provider?.models.length ?? 0,
            })}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t('providers:removeProvider.keepsHistory')}
        </p>
        <DialogFooter className="mt-2">
          <DialogClose asChild>
            {/* Focus starts on the answer that removes nothing. */}
            <Button
              variant="ghost"
              size="sm"
              autoFocus
              className="pointer-coarse:h-11"
            >
              {t('providers:removeProvider.cancel')}
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={onConfirm}
          >
            {t('providers:removeProvider.remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
