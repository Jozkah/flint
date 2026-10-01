import type { IconId } from './icons'

/** The built-in assistants' marks (#47), as the desktop's picker draws them. */
export const ASSISTANT_ICON: Record<string, [IconId, string]> = {
  Quartz: ['gem', '#a78bfa'],
  Coal: ['pick', '#94a3b8'],
  Blaze: ['flame', '#fb923c'],
  Redstone: ['cpu2', '#f87171'],
}
