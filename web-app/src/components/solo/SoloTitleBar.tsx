import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import {
  detectMacOverlay,
  detectWindowChrome,
  headerDragsWindow,
} from '@/lib/titlebar'

/**
 * The slim bar of a "New window": the conversation's title and, where Flint
 * draws its own window chrome, room for the window controls (drawn by the
 * shell). Nothing else lives here.
 * With a native title bar (Windows) the system draws the title and controls,
 * so nothing is drawn here: exactly one header per window.
 */
export function SoloTitleBar({ title }: { title: string }) {
  const macOverlay = useMemo(() => detectMacOverlay(), [])
  const chrome = useMemo(() => detectWindowChrome({ macOverlay }), [macOverlay])
  const drags = headerDragsWindow(chrome)
  const dragRegion = drags ? { 'data-tauri-drag-region': true } : {}

  // A native title bar already shows the conversation title and owns the
  // caption buttons: a second row here would only repeat it.
  if (chrome === 'native') return null

  return (
    <header
      {...dragRegion}
      data-testid="solo-titlebar"
      className={cn(
        'flex w-full shrink-0 items-center px-3',
        chrome === 'custom' ? 'h-13' : 'h-9',
        macOverlay && 'pl-24',
        chrome === 'custom' && 'pr-32'
      )}
    >
      <span
        {...dragRegion}
        data-testid="solo-title"
        title={title}
        className="min-w-0 flex-1 truncate text-sm font-medium text-foreground select-none"
      >
        {title}
      </span>
    </header>
  )
}
