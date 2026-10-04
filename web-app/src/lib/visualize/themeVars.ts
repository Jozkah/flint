/**
 * The app tokens a widget may use. Read from the live document, so the
 * widget follows the accent, the dark/light choice and the font the user set
 * instead of a copy of the stylesheet.
 */
export const THEME_VAR_NAMES = [
  '--background',
  '--foreground',
  '--fg-2',
  '--card',
  '--card-foreground',
  '--popover',
  '--primary',
  '--primary-foreground',
  '--primary-hover',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--subtle-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--destructive-tint',
  '--success',
  '--success-tint',
  '--warning',
  '--warning-tint',
  '--info',
  '--border',
  '--border-strong',
  '--input',
  '--ring',
  '--track',
  '--knob',
  '--code-bg',
  '--radius',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
] as const

const FONT_VARS = ['--font-sans', '--font-mono'] as const

export type ThemeSnapshot = { vars: Record<string, string>; dark: boolean }

/** Defaults for a document with no stylesheet (tests, a bare preview page). */
const FALLBACK: Record<string, string> = {
  '--background': '#F8F8F8',
  '--foreground': '#1F2937',
  '--card': '#FFFFFF',
  '--muted': '#F6F6F6',
  '--muted-foreground': '#6B7280',
  '--border': '#E5E7EB',
  '--border-strong': '#D1D5DB',
  '--primary': '#1F2937',
  '--primary-foreground': '#FFFFFF',
  '--accent': '#F3F4F6',
  '--radius': '8px',
}

export function readThemeSnapshot(
  doc: Document = document,
  win: Window = window
): ThemeSnapshot {
  const root = doc.documentElement
  const style = win.getComputedStyle(root)
  const vars: Record<string, string> = {}
  for (const name of [...THEME_VAR_NAMES, ...FONT_VARS]) {
    const value = style.getPropertyValue(name).trim()
    if (value) vars[name] = value
    else if (FALLBACK[name]) vars[name] = FALLBACK[name]
  }
  // The app's radius is in rem; a widget's rem is its own, so pass pixels.
  const radius = vars['--radius'] ?? '8px'
  const px = /rem$/.test(radius) ? parseFloat(radius) * 16 : parseFloat(radius)
  const r = Number.isFinite(px) ? Math.round(px) : 8
  vars['--radius'] = `${r}px`
  vars['--radius-sm'] = `${Math.max(2, r - 3)}px`
  return { vars, dark: root.classList.contains('dark') }
}

/** Calls `onChange` when the document's theme classes or inline tokens change. */
export function watchTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'data-accent'],
  })
  return () => observer.disconnect()
}
