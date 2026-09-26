import { useState } from 'react'
import { MoreHorizontal, Pencil, Power, TextCursorInput, Trash2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
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
  onRename,
  onRemove,
  className,
}: {
  provider: ProviderObject
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onEdit: () => void
  onToggle: () => void
  onRename: () => void
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
        {actions.includes('rename') && (
          <DropdownMenuItem onSelect={onRename}>
            <TextCursorInput />
            {t('providers:cardMenu.rename')}
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

/**
 * Renames a provider for display only. The provider key, its keyring secret
 * and the threads that reference it keep the original name; an empty name
 * returns to the default title.
 */
export function RenameProviderDialog({
  provider,
  defaultTitle,
  onOpenChange,
  onSave,
}: {
  provider: ProviderObject | null
  /** The built-in title, shown as the placeholder. */
  defaultTitle: string
  onOpenChange: (open: boolean) => void
  onSave: (displayName: string | undefined) => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={!!provider} onOpenChange={onOpenChange}>
      <DialogContent data-testid="rename-provider-dialog">
        {provider && (
          <RenameForm
            key={provider.provider}
            initial={provider.displayName ?? ''}
            placeholder={defaultTitle}
            onSave={onSave}
            t={t}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function RenameForm({
  initial,
  placeholder,
  onSave,
  t,
}: {
  initial: string
  placeholder: string
  onSave: (displayName: string | undefined) => void
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  const [value, setValue] = useState(initial)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSave(value.trim() || undefined)
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('providers:renameProvider.title')}</DialogTitle>
        <DialogDescription>
          {t('providers:renameProvider.description')}
        </DialogDescription>
      </DialogHeader>
      <Input
        autoFocus
        className="mt-3"
        aria-label={t('providers:renameProvider.label')}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
      />
      <DialogFooter className="mt-4">
        <DialogClose asChild>
          <Button type="button" variant="ghost" size="sm" className="pointer-coarse:h-11">
            {t('providers:renameProvider.cancel')}
          </Button>
        </DialogClose>
        <Button type="submit" size="sm" className="pointer-coarse:h-11">
          {t('providers:renameProvider.save')}
        </Button>
      </DialogFooter>
    </form>
  )
}
