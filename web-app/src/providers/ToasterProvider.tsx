import { Toaster } from '@/components/ui/sonner'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { getToastOffset } from '@/utils/toastPlacement'

export function ToasterProvider() {
  const notificationPosition = useInterfaceSettings(
    (s) => s.notificationPosition
  )

  return (
    <Toaster
      richColors
      // A failure message worth reading is worth being able to put away. Some
      // of them name an endpoint, a status and what to do about it, and until
      // now the only way to clear one was to wait for it to time out.
      closeButton
      position={notificationPosition}
      offset={getToastOffset(notificationPosition)}
      visibleToasts={5}
      toastOptions={{
        style: {
          padding: '1rem 0.8rem',
          alignItems: 'start',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          MozUserSelect: 'none',
          msUserSelect: 'none',
        },
        classNames: {
          toast: 'toast select-none',
          title: 'text-foreground! select-none',
          description: 'text-muted-foreground! select-none',
        },
      }}
    />
  )
}
