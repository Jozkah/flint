/**
 * Changing one shortcut. AH-207.
 *
 * "Change" starts recording; the next chord pressed is offered to the store,
 * which refuses one another command already uses and names that command. The
 * refusal stays on screen until the user tries again or cancels, so it cannot
 * flash past unread.
 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useKeybindings, specFromEvent } from '@/hooks/useKeybindings'
import { PlatformShortcuts, type ShortcutAction } from '@/lib/shortcuts'

export function ShortcutRebind({
  action,
  label,
  children,
}: {
  action: ShortcutAction
  /** The command's own name, for the conflict message of another row. */
  label: (action: ShortcutAction) => string
  /** The current binding, rendered by the caller. */
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const customised = useKeybindings((s) => s.overrides[action] !== undefined)

  useEffect(() => {
    if (!recording) return
    // Every app shortcut stands down while this is set, whatever order the
    // listeners happen to run in.
    useKeybindings.getState().setRecording(true)
    const onKeyDown = (e: KeyboardEvent) => {
      // Captured before the app's own shortcuts, so pressing a chord that is
      // already bound records it instead of running its command.
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      const spec = specFromEvent(e)
      if (!spec) return
      const result = useKeybindings.getState().bind(action, spec)
      if (result.ok) {
        setError(null)
        setRecording(false)
      } else if (result.reason === 'conflict') {
        setError(
          t('settings:shortcuts.conflict', { command: label(result.with) })
        )
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      useKeybindings.getState().setRecording(false)
    }
  }, [recording, action, label, t])

  return (
    <div
      className="flex flex-col items-start gap-1 sm:items-end"
      data-testid={`rebind-${action}`}
    >
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {recording ? (
          <span
            className="text-xs text-muted-foreground"
            data-testid="rebind-recording"
          >
            {t('settings:shortcuts.pressKeys')}
          </span>
        ) : (
          children
        )}
        <Button
          size="sm"
          variant="ghost"
          className="text-acc-text pointer-coarse:h-11"
          onClick={() => {
            setError(null)
            setRecording((r) => !r)
          }}
          data-testid="rebind-change"
        >
          {recording ? t('common:cancel') : t('settings:shortcuts.change')}
        </Button>
        {customised && !recording ? (
          <Button
            size="sm"
            variant="ghost"
            className="pointer-coarse:h-11"
            onClick={() => useKeybindings.getState().reset(action)}
            data-testid="rebind-reset"
            title={PlatformShortcuts[action].key}
          >
            {t('settings:shortcuts.reset')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p
          className="text-xs text-destructive"
          role="alert"
          data-testid="rebind-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}
