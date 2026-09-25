/**
 * First-paint appearance snapshot.
 *
 * Theme and interface settings live in the backend store (settings.json),
 * which only hydrates after the app has booted, so the first frames would
 * otherwise paint in the light theme with the default accent and flash. This
 * module mirrors what those settings resolve to into one synchronous
 * localStorage entry that the inline script in `index.html` reads before
 * anything paints. The settings stores stay the source of truth; this is a
 * cache the pre-paint script can reach.
 *
 * Keep the shape in step with the script in index.html.
 */
import {
  accentBase,
  accentCssVariables,
  deriveAccentTokens,
  isNeutralSelection,
  type AccentSelection,
  type AccentTheme,
} from '@/lib/accent'

export const BOOT_APPEARANCE_KEY = 'flint-boot'

export type BootAppearance = {
  /** The user's theme choice; `auto` follows the OS at boot. */
  theme: 'auto' | 'light' | 'dark'
  /** The theme that was in effect when the snapshot was written. */
  dark: boolean
  /** Inline accent variables per theme. Empty for the neutral default. */
  vars: Record<AccentTheme, Record<string, string>>
  fontSize: string
  reduceMotion: boolean
}

export function buildBootAppearance(input: {
  theme: string
  isDark: boolean
  accent: AccentSelection
  fontSize: string
  reduceMotion: boolean
}): BootAppearance {
  const varsFor = (theme: AccentTheme) =>
    isNeutralSelection(input.accent)
      ? {}
      : accentCssVariables(
          deriveAccentTokens(accentBase(input.accent, theme).hex, theme)
        )
  const theme =
    input.theme === 'light' || input.theme === 'dark' ? input.theme : 'auto'
  return {
    theme,
    dark: input.isDark,
    vars: { light: varsFor('light'), dark: varsFor('dark') },
    fontSize: input.fontSize,
    reduceMotion: input.reduceMotion,
  }
}

export function writeBootAppearance(snapshot: BootAppearance): void {
  try {
    localStorage.setItem(BOOT_APPEARANCE_KEY, JSON.stringify(snapshot))
  } catch {
    // Storage can be unavailable (private mode, quota); the app still renders
    // correctly once the settings stores hydrate, only the first frame differs.
  }
}

/** Two frames after mount the real stylesheet and settings are in place, so
 * transitions can run again. */
export function releasePreload(root: HTMLElement = document.documentElement) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => root.classList.remove('preload'))
  )
}
