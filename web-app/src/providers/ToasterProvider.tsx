import { Toaster } from '@/components/ui/sonner'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { getToastOffset } from '@/utils/toastPlacement'

/** Below the 52px top header on phones, so a toast never sits over the composer. */
const PHONE_OFFSET = { top: '60px' }

export function ToasterProvider() {
  const notificationPosition = useInterfaceSettings(
    (s) => s.notificationPosition
  )
  const isPhone = useMediaQuery('(max-width: 767px)')

  const offset = getToastOffset(notificationPosition)

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
          padding: '0.75rem',
          alignItems: 'start',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          MozUserSelect: 'none',
          msUserSelect: 'none',
        },
        // One neutral surface for every toast. Typed ones say what they are
        // through a semantic icon beside the words, never a coloured slab and
        // never the accent: an error must not look like a selection.
        classNames: {
          toast: 'toast select-none rounded-lg! shadow-pop! font-sans!',
          title: 'text-[13px]! leading-snug! text-foreground! font-medium! select-none',
          description: 'text-xs! leading-relaxed! text-fg-2! select-none',
          closeButton:
            'bg-card! border-border! text-muted-foreground! hover:text-foreground!',
          actionButton: 'bg-primary! text-primary-foreground!',
          cancelButton: 'bg-muted! text-foreground!',
          success:
            'bg-card! border-border! [&_[data-icon]]:text-success!',
          error:
            'bg-card! border-border! [&_[data-icon]]:text-destructive!',
          warning:
            'bg-card! border-border! [&_[data-icon]]:text-warning!',
          info: 'bg-card! border-border! [&_[data-icon]]:text-fg-2!',
          loading:
            'bg-card! border-border! [&_[data-icon]]:text-muted-foreground!',
        },
      }}
    />
  )
}
