import { useEffect, useState, type ReactNode } from 'react'
import { Segmented } from '@/components/ui/segmented'
import { useSettingsSearch } from '@/hooks/useSettingsSearch'

/** One tab of a settings page. */
export type SettingsTab<T extends string = string> = {
  id: T
  label: ReactNode
  /**
   * Anchor ids of the settings on this tab, so a search result opens the tab
   * that holds it. An entry ending in `*` matches by prefix.
   */
  anchors?: readonly string[]
}

const holds = (anchors: readonly string[] | undefined, anchor: string) =>
  anchors?.some((a) =>
    a.endsWith('*') ? anchor.startsWith(a.slice(0, -1)) : a === anchor
  ) ?? false

/**
 * The selected tab of a settings page. Search results name a setting by
 * anchor; when that setting sits on a tab that is not showing, the tab opens
 * first, so the group mounts and the arrival scroll and highlight still land.
 */
export function useSettingsTab<T extends string>(
  tabs: readonly SettingsTab<T>[],
  initial?: T
): [T, (tab: T) => void] {
  const [tab, setTab] = useState<T>(initial ?? tabs[0].id)
  const pendingTarget = useSettingsSearch((s) => s.pendingTarget)
  useEffect(() => {
    if (!pendingTarget) return
    const owner = tabs.find((t) => holds(t.anchors, pendingTarget))
    if (owner) setTab(owner.id)
    // `tabs` is rebuilt on every render; the target is what should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTarget])
  return [tab, setTab]
}

/**
 * The tab strip, as the Agent page's Skills and Memories tabs already draw it:
 * the gradient pill on a row of equal buttons, in the page's action slot.
 */
export function SettingsTabStrip<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: readonly SettingsTab<T>[]
  value: T
  onChange: (tab: T) => void
  label: string
}) {
  return (
    <div style={{ width: `min(100%, ${tabs.length * 8}rem)` }}>
      <Segmented<T>
        size="sm"
        aria-label={label}
        value={value}
        onValueChange={onChange}
        options={tabs.map((t) => ({ value: t.id, label: t.label }))}
      />
    </div>
  )
}
