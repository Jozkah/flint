import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SETTINGS_ITEMS } from '@/lib/settingsSearch'

// An anchor the registry advertises but no page renders is invisible in every
// other test: the entry is well-formed, the route exists, navigation works —
// and then nothing scrolls, focuses or highlights, which looks like a dead
// link. Three anchors had already drifted that way (the Local API server host
// and port, which live in a popover, and a Vulkan toggle whose UI was gone).
//
// Rendering all thirteen settings pages to check would need a deep mock each;
// a source scan is what `locales/__tests__/localeKeys.test.ts` already does
// for the same class of problem, so this follows it.

const SRC = resolve(__dirname, '../..')
const REGISTRY = join(SRC, 'lib/settingsSearch.ts')

/** Every non-test `.tsx` under a settings surface that can render a target. */
function pageSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) pageSources(full, acc)
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) acc.push(full)
  }
  return acc
}

const ANCHOR = /settings-[a-z0-9-]+/g

/**
 * Anchors the settings pages actually render.
 *
 * Two forms count. A literal — `anchor="settings-general-language"`, or an
 * entry of the `SETTING_ANCHORS` map that attachments.tsx indexes by schema
 * key — is picked up straight from the page source. An identifier —
 * `anchor={WEB_SEARCH_PROVIDER_CONFIG_ANCHOR}` — is resolved through the
 * registry's own exported constant, which is the point of exporting it: the
 * page and the registry name one value, so they cannot drift.
 */
function renderedAnchors(): Set<string> {
  const rendered = new Set<string>()
  const registry = readFileSync(REGISTRY, 'utf8')

  for (const file of pageSources(join(SRC, 'routes/settings'))) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(ANCHOR)) rendered.add(match[0])

    for (const [, name] of source.matchAll(/anchor=\{([A-Z][A-Z0-9_]*)\}/g)) {
      const declared = registry.match(
        new RegExp(`export const ${name}\\s*(?::[^=]*)?=\\s*'(settings-[a-z0-9-]+)'`)
      )
      expect(declared, `${name} is not an exported anchor constant`).toBeTruthy()
      rendered.add(declared![1])
    }
  }
  return rendered
}

describe('settings anchors', () => {
  it('renders a SettingTarget for every anchor the registry advertises', () => {
    const rendered = renderedAnchors()
    const dangling = SETTINGS_ITEMS.filter(
      (item) => item.anchor && !rendered.has(item.anchor)
    ).map((item) => `${item.id} -> ${item.anchor}`)

    expect(
      dangling,
      'registry anchors with no SettingTarget on any settings page'
    ).toEqual([])
  })

  it('finds the anchors it is scanning for', () => {
    // Guards the scan itself: a regex or path that silently matched nothing
    // would make the test above pass for the wrong reason.
    const rendered = renderedAnchors()
    expect(rendered.size).toBeGreaterThan(10)
    expect(rendered).toContain('settings-general-language')
    // Resolved through the exported constant, not a literal in the page.
    expect(rendered).toContain('settings-web-search-provider-config')
  })

  it('lets a setting be indexed without an anchor', () => {
    // Host and port live in a popover that unmounts, so they deliberately
    // carry none: findable and navigable, with no highlight promised.
    const hostless = SETTINGS_ITEMS.filter((item) => !item.anchor).map(
      (item) => item.id
    )
    expect(hostless).toEqual([
      'settings-local-api-server-host',
      'settings-local-api-server-port',
    ])
  })
})
