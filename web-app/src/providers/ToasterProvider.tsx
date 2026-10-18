import { Toaster } from '@/components/ui/sonner'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useEffect, useState } from 'react'
import { useLocation } from '@tanstack/react-router'
import { useWebPreview } from '@/hooks/useWebPreview'
import { useDialogOpen } from '@/hooks/useDialogOpen'
import {
  NARROW_TOAST_PX,
  composerClearanceFor,
  getDialogToastPlacement,
  getNarrowToastPlacement,
  getToastOffsetAvoidingPane,
} from '@/utils/toastPlacement'
import { notifyToasterMounted } from '@/lib/settingsRecoveryNotice'
import { installToastDedupe } from '@/lib/toastDedupe'

installToastDedupe()

export function ToasterProvider() {
  const notificationPosition = useInterfaceSettings(
    (s) => s.notificationPosition
  )
  const isPhone = useMediaQuery(`(max-width: ${NARROW_TOAST_PX}px)`)

  // A toast raised before this mounted is shown again now.
  useEffect(() => {
    notifyToasterMounted()
  }, [])

  const pathname = useLocation({ select: (l) => l.pathname })
  const open = useWebPreview((s) => s.open)
  const surface = useWebPreview((s) => s.surface)
  const paneRect = useWebPreview((s) => s.paneRect)
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
  useEffect(() => {
    const onResize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Keep toasts clear of the open Web preview pane and its toolbar.
  const offset = getToastOffsetAvoidingPane(
    notificationPosition,
    open && paneRect ? { surface, rect: paneRect } : null,
    viewport,
    composerClearanceFor(pathname)
  )

  // A modal's header and close button sit where a top toast lands.
  const dialogOpen = useDialogOpen()
  const dialogPlacement = dialogOpen
    ? getDialogToastPlacement(viewport.width)
    : null
  // Phones: full width, bottom-center, above the composer. Never at the top,
  // where the header's controls are.
  const phonePlacement = isPhone ? getNarrowToastPlacement() : null
  const placement = dialogPlacement ?? phonePlacement

  return (
    <Toaster
      // A failure message worth reading is worth being able to put away. Some
      // of them name an endpoint, a status and what to do about it, and until
      // now the only way to clear one was to wait for it to time out.
      closeButton
      position={placement?.position ?? notificationPosition}
      offset={placement?.offset ?? offset}
      mobileOffset={
        placement?.mobileOffset ?? getNarrowToastPlacement().mobileOffset
      }
      // Three at most; older ones wait until one is dismissed. Sonner pauses
      // the auto-dismiss timer while the pointer is over the stack.
      visibleToasts={3}
      duration={5000}
      // Stacked toasts sit one under another with a gap; sonner's collapsed
      // pile lays them over each other until hovered.
      expand
      gap={8}
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
