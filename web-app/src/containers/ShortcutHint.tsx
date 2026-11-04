/**
 * The chord an action is bound to right now, for a menu's hint. AH-207.
 *
 * Reads the binding in force, so a user who moved New Chat to another chord
 * is not shown the default one beside the button.
 */
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { PlatformMetaKey } from '@/containers/PlatformMetaKey'
import { useKeybindings } from '@/hooks/useKeybindings'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ShortcutAction } from '@/lib/shortcuts'

export function ShortcutHint({ action }: { action: ShortcutAction }) {
  const { t } = useTranslation()
  // Subscribing to the override is what re-renders the hint when it changes.
  useKeybindings((s) => s.overrides[action])
  const spec = useKeybindings.getState().specFor(action)
  const cls = 'bg-transparent size-3'
  return (
    <KbdGroup className="ml-auto scale-90 gap-0" data-testid={`hint-${action}`}>
      {spec.usePlatformMetaKey ? (
        <Kbd className={cls}>
          <PlatformMetaKey />
        </Kbd>
      ) : null}
      {spec.ctrlKey ? <Kbd className={cls}>{t('common:shortcutKeys.ctrl')}</Kbd> : null}
      {spec.metaKey ? <Kbd className={cls}>⌘</Kbd> : null}
      {spec.altKey ? <Kbd className={cls}>{t('common:shortcutKeys.alt')}</Kbd> : null}
      {spec.shiftKey ? <Kbd className={cls}>⇧</Kbd> : null}
      <Kbd className={`${cls} uppercase`}>{spec.key}</Kbd>
    </KbdGroup>
  )
}
