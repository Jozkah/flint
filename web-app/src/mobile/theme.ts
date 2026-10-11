// Light and dark follow the phone (or the choice in Settings › Appearance);
// the accent follows the computer's (`appearance.get`), applied as the same
// inline variables the desktop writes (lib/accent.ts).
import type { AppearanceResult } from '@/lib/remote/protocol'
import { app, client } from './state/app'

let accent: AppearanceResult['vars'] | null = null
let applied: string[] = []

/** Light or dark from the phone (or the saved choice). Exported so the first
 * screen of the iOS shell, which shows before the app starts, is themed too. */
export function apply() {
  const root = document.documentElement
  const pref = app.get().theme
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
  for (const k of applied) root.style.removeProperty(k)
  applied = []
  const vars = accent?.[dark ? 'dark' : 'light'] ?? {}
  for (const [k, v] of Object.entries(vars)) {
    if (!/^--[a-z0-9-]+$/.test(k)) continue
    root.style.setProperty(k, v)
    applied.push(k)
  }
  // iOS tint: the computer's accent when it sent one, else systemBlue (ios.css).
  const tint = vars['--acc-text']
  if (tint) {
    root.style.setProperty('--ios-accent', tint)
    applied.push('--ios-accent')
  }
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((m) => m.setAttribute('content', dark ? '#0A0B0D' : '#F8F8F8'))
}

export function startTheme() {
  apply()
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply)
  let last = app.get().theme
  let lastAuth = app.get().auth
  app.subscribe(() => {
    const { theme, auth } = app.get()
    if (theme !== last) {
      last = theme
      apply()
    }
    if (auth !== lastAuth) {
      lastAuth = auth
      if (auth === 'paired') void loadAccent()
    }
  })
}

async function loadAccent() {
  try {
    accent = (await client().rpc('appearance.get', {})).vars
    apply()
  } catch {
    // The default accent.
  }
}
