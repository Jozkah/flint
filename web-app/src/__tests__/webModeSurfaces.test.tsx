/**
 * The browser served by `flint serve`: surfaces whose backend is the desktop
 * app show "Available in the Flint desktop app only" instead of a control that
 * would fail, and ask for no desktop-only command while they render.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DESKTOP_ONLY_COMMANDS } from '@/lib/desktopOnlyCommands'

const invoke = vi.hoisted(() => vi.fn(async () => null))
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => false }))
vi.mock('@/lib/platform/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/utils')>()),
  isServedByFlint: () => true,
  isPlatformTauri: () => false,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('@/lib/obsidianVault', () => ({ useObsidianVault: () => false }))

/**
 * Desktop-only commands a web page may still ask for (refused locally by the
 * browser shim, so no request is made) because the page already handles the
 * refusal quietly. Empty: every surface below asks for none.
 */
const TOLERATED_IN_WEB: ReadonlySet<string> = new Set()

function desktopOnlyCalls(): string[] {
  return invoke.mock.calls
    .map((call) => String((call as unknown[])[0]))
    .filter((c) => DESKTOP_ONLY_COMMANDS.has(c) && !TOLERATED_IN_WEB.has(c))
}

describe('web mode desktop-only surfaces', () => {
  beforeEach(() => invoke.mockClear())

  it('hides "Add my Obsidian vault" in the browser', async () => {
    const { CoworkEmptyState } = await import('@/containers/CoworkEmptyState')
    render(<CoworkEmptyState folder={null} onPick={() => {}} onAttachFolder={() => {}} />)
    expect(screen.queryByTestId('cowork-add-vault')).toBeNull()
    expect(desktopOnlyCalls()).toEqual([])
  })

  it('shows token limits as desktop-only and never polls them', async () => {
    const { UsageCeilingsCard } = await import('@/containers/UsageCeilingsCard')
    render(<UsageCeilingsCard />)
    expect(screen.getByTestId('usage-ceilings-desktop-only')).toHaveTextContent('permissions:desktopOnly')
    await waitFor(() => expect(desktopOnlyCalls()).toEqual([]))
    expect(invoke).not.toHaveBeenCalledWith('get_usage_ceilings', expect.anything())
  })

  it('renders a desktop-only page in place of a desktop page', async () => {
    const { DesktopOnlyPage } = await import('@/containers/DesktopOnlyPage')
    render(<DesktopOnlyPage title="Archive" />)
    expect(screen.getByTestId('desktop-only-page')).toHaveTextContent('permissions:desktopOnly')
  })

  it('keeps desktop-only pages out of the browser settings menu', async () => {
    const { isSettingsPageAvailable } = await import('@/lib/settingsSearch')
    for (const id of ['agent-tools', 'schedules', 'local-api-server']) {
      expect(isSettingsPageAvailable(id), id).toBe(false)
    }
    expect(isSettingsPageAvailable('memory')).toBe(true)
  })

  it.each([
    ['settings/local-api-server', '@/routes/settings/local-api-server'],
    ['settings/remote-access', '@/routes/settings/remote-access'],
    ['extensions', '@/routes/extensions'],
    ['studio', '@/routes/studio'],
  ])('opens /%s by URL as the desktop-only page, never an error', async (_name, path) => {
    const mod = (await import(/* @vite-ignore */ path)) as {
      Route: { options: { component: React.ComponentType } }
    }
    const Component = mod.Route.options.component
    render(<Component />)
    expect(screen.getByTestId('desktop-only-page')).toHaveTextContent('permissions:desktopOnly')
    expect(desktopOnlyCalls()).toEqual([])
  })

  it('keeps desktop-only pages out of page search and the palette', async () => {
    const { buildPageIndex } = await import('@/lib/searchDialogPages')
    const ids = buildPageIndex((k) => k).map((p) => p.id)
    for (const id of ['studio', 'extensions', 'local-api', 'schedules']) {
      expect(ids, id).not.toContain(id)
    }
    expect(ids).toContain('cowork')
    const { isNavItemAvailable } = await import('@/lib/sidebarItems')
    expect(isNavItemAvailable('studio')).toBe(false)
    expect(isNavItemAvailable('models')).toBe(true)
  })
})
