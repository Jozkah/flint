import { Toaster } from '@/components/ui/sonner'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { getToastOffset } from '@/utils/toastPlacement'

/** Below the context bar on phones, so a toast never sits over the composer. */
const PHONE_OFFSET = { top: 'calc(var(--ctx-h) + 8px)' }

export function ToasterProvider() {
  const notificationPosition = useInterfaceSettings(
    (s) => s.notificationPosition
  )
  const isPhone = useMediaQuery('(max-width: 767px)')

  const base = getToastOffset(notificationPosition)
  // The status bar runs along the bottom of the shell; a bottom toast clears
  // it rather than covering it.
  const offset =
    typeof base === 'object' && 'bottom' in base
      ? { ...base, bottom: 'calc(var(--status-h) + 8px)' }
      : base

  return (
    <Toaster
      // A failure message worth reading is worth being able to put away. Some
      // of them name an endpoint, a status and what to do about it, and until
      // now the only way to clear one was to wait for it to time out.
      closeButton
      position={isPhone ? 'top-center' : notificationPosition}
      offset={isPhone ? PHONE_OFFSET : offset}
      mobileOffset={PHONE_OFFSET}
      visibleToasts={5}
      toastOptions={{
        style: {
          padding: '0.875rem 0.875rem',
          alignItems: 'start',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          MozUserSelect: 'none',
          msUserSelect: 'none',
        },
        // Paper surfaces with a semantic icon. Neutral toasts keep the accent
        // tint from `.toaster` in index.css; typed ones say what they are
        // through the icon colour, not a coloured slab.
        classNames: {
          toast: 'toast select-none rounded-lg! shadow-overlay! font-sans!',
          title: 'text-foreground! font-medium! select-none',
          description: 'text-muted-foreground! select-none',
          closeButton:
            'bg-card! border-border! text-muted-foreground! hover:text-foreground!',
          actionButton: 'bg-brand-fill! text-brand-foreground!',
          cancelButton: 'bg-sunken! text-foreground!',
          success:
            'bg-card! border-border! [&_[data-icon]]:text-success!',
          error:
            'bg-card! border-border! [&_[data-icon]]:text-destructive!',
          warning:
            'bg-card! border-border! [&_[data-icon]]:text-warning!',
          info: 'bg-card! border-border! [&_[data-icon]]:text-brand-text!',
          loading: '[&_[data-icon]]:text-muted-foreground!',
        },
      }}
    />
  )
}
