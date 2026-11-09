import { browser, $ } from '@wdio/globals'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Every top-level page opens in the real app without falling into an error
// screen. This is the startup regression net the two smoke tests do not
// cast: a page whose chunk fails to load, whose loader throws, or whose route
// was renamed shows one of three screens, and each is looked for by its
// English text (read from the app's own strings, so a copy edit does not
// break the test).

const common = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'web-app', 'src', 'locales', 'en', 'common.json'), 'utf8')
) as { routeLoading: { failed: string }; routeNotFound: { title: string } }

const ERROR_SCREENS = [
  common.routeLoading.failed, // RouteLoadError: the page's code failed to load or threw
  common.routeNotFound.title, // RouteNotFound: no such route
  'Something went wrong', // GlobalError (hard-coded English there)
]

// Static routes only (no ids to invent). The logs and system-monitor pages are
// left out: they are their own windows and read live hardware.
const ROUTES = [
  '/overview',
  '/cowork',
  '/artifacts',
  '/studio',
  '/translate',
  '/archive',
  '/extensions',
  '/project',
  '/campaigns',
  '/rooms',
  '/hub/',
  '/settings/general',
  '/settings/providers',
  '/settings/chat',
  '/settings/data',
  '/settings/integrations',
  '/settings/attachments',
  '/settings/appearance',
  '/settings/shortcuts',
  '/settings/extensions',
  '/settings/local-api-server',
  '/settings/mcp-servers',
  '/settings/network-proxy',
  '/settings/web-search',
  '/settings/agent',
  '/settings/memory',
  '/settings/schedules',
  '/settings/permissions',
  '/settings/assistant',
  '/settings/claude-code',
  '/settings/remote-access',
]

/** Client-side navigation, as in smoke.e2e.ts (see the comment there). */
async function push(path: string) {
  await browser.execute((target: string) => {
    const previous = (window.history.state ?? {}) as Record<string, unknown>
    const index =
      typeof previous.__TSR_index === 'number' ? previous.__TSR_index + 1 : 0
    const key = Math.random().toString(36).slice(2, 10)
    window.history.pushState(
      { ...previous, __TSR_index: index, key, __TSR_key: key },
      '',
      target
    )
  }, path)
}

describe('Flint desktop app routes', () => {
  before(async () => {
    await $('#root').waitForExist({ timeout: 60_000 })
    await $('[data-testid="setup-wizard"]').waitForDisplayed({ timeout: 60_000 })
  })

  for (const path of ROUTES) {
    it(`opens ${path} without an error screen`, async () => {
      await push(path)
      // A page may redirect (first-run, aliases), so the exact path is not
      // awaited. Lazy chunks and loaders settle; an error screen replaces the
      // page within this time when one is coming.
      await browser.pause(1_500)
      const text = await browser.execute(() => document.body.innerText)
      for (const screen of ERROR_SCREENS) {
        if (text.includes(screen)) {
          throw new Error(`${path} shows "${screen}":\n${text.slice(0, 600)}`)
        }
      }
    })
  }
})
