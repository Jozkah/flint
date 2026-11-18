import { Toaster } from '@/components/ui/sonner'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useRouterState } from '@tanstack/react-router'
import { UNKNOWN_WINDOW_TOAST_ID } from '@/lib/toastIds'
import { useWebPreview } from '@/hooks/useWebPreview'
import { useDialogOpen } from '@/hooks/useDialogOpen'
import {
  NARROW_TOAST_PX,
  composerAwareClearance,
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

  // The context-size notice belongs to the chat that raised it: it must not
  // follow the user onto another page and sit over that page's controls.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  useEffect(() => {
    toast.dismiss(UNKNOWN_WINDOW_TOAST_ID)
  }, [pathname])

  // A toast raised before this mounted is shown again now.
  useEffect(() => {
    notifyToasterMounted()
  }, [])

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

  // Where the composer is now, so a corner toast never covers its controls.
  const [clearance, setClearance] = useState(() =>
    composerAwareClearance(null, viewport)
  )
  useEffect(() => {
    const measure = () => {
      const el = document.querySelector('[data-composer]')
      const rect = el ? el.getBoundingClientRect() : null
      const next = composerAwareClearance(rect, {
        width: window.innerWidth,
        height: window.innerHeight,
      })
      setClearance((prev) => (prev === next ? prev : next))
    }
    measure()
    // The composer mounts, grows and moves with the route and its text, and
    // none of that raises an event here: a cheap poll tracks it.
    const timer = window.setInterval(measure, 500)
    return () => window.clearInterval(timer)
  }, [viewport])

  // Keep toasts clear of the open Web preview pane and its toolbar.
  const offset = getToastOffsetAvoidingPane(
    notificationPosition,
    open && paneRect ? { surface, rect: paneRect } : null,
    viewport,
    clearance
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
        },
        // One neutral surface for every toast. Typed ones say what they are
        // through a semantic icon beside the words, never a coloured slab and
        // never the accent: an error must not look like a selection.
        classNames: {
          toast: 'toast rounded-lg! shadow-pop! font-sans!',
          title: 'text-[length:calc(var(--ui-font-base)*0.8125)]! leading-snug! text-foreground! font-medium!',
          description: 'text-xs! leading-relaxed! text-fg-2!',
          closeButton:
            'hit-box [--hit-x:-10px] [--hit-y:-10px] bg-card! border-border! text-muted-foreground! hover:text-foreground!',
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
