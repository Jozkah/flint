import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F6-001 / RTE-016: the webview's CSP stays as narrow as the code needs.
//
// Only what is known safe is pinned here. connect-src still allows `https:`
// and `http:` because the webview itself fetches user-chosen origins (a remote
// Flint server in serverConnection.ts / remoteRunner.ts, provider base URLs
// when the Tauri HTTP plugin is absent, huggingface.co from ModelDefaultsCard,
// preview file fetches); narrowing it needs a live smoke of each of those and
// a move to the HTTP plugin first. frame-src keeps `https:` for the browsing
// pane's iframe mode (a framed page has no IPC).
const conf = JSON.parse(
  readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')
)
const csp = conf.app.security.csp
const tokens = (directive) => String(csp[directive] ?? '').split(/\s+/).filter(Boolean)

test('script-src runs only the app bundle', () => {
  const t = tokens('script-src')
  assert.ok(t.includes("'self'"), "script-src lost 'self'")
  for (const bad of ['asset:', 'http://asset.localhost', "'unsafe-eval'", "'unsafe-inline'", 'https:', 'http:', 'data:', 'blob:']) {
    assert.ok(!t.includes(bad), `script-src allows ${bad}`)
  }
})

test('plugins and base URL stay locked', () => {
  assert.deepEqual(tokens('object-src'), ["'none'"])
  assert.deepEqual(tokens('base-uri'), ["'self'"])
  assert.deepEqual(tokens('form-action'), ["'self'"])
})

test('no directive allows eval', () => {
  for (const [name, value] of Object.entries(csp)) {
    const list = Array.isArray(value) ? value.join(' ') : String(value)
    assert.ok(!list.includes("'unsafe-eval'"), `${name} allows unsafe-eval`)
  }
})

test('no platform override sets its own CSP', () => {
  for (const platform of ['android', 'ios', 'linux', 'macos', 'windows']) {
    const other = JSON.parse(
      readFileSync(new URL(`../src-tauri/tauri.${platform}.conf.json`, import.meta.url), 'utf8')
    )
    assert.equal(other?.app?.security?.csp, undefined, `${platform} overrides the CSP`)
  }
})
