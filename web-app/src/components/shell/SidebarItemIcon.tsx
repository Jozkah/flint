import { Icon } from '@/components/ui/icon'
import type { SidebarItem } from '@/lib/sidebarItems'

/** The glyph of a sidebar destination: the sidebar and its picker both draw it here. */
export function SidebarItemIcon({ item }: { item: Pick<SidebarItem, 'icon' | 'lucide'> }) {
  const Lucide = item.lucide
  return Lucide ? <Lucide aria-hidden /> : <Icon name={item.icon} />
}
