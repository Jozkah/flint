import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F6-001 / RTE-016: the webview's CSP stays as narrow as the code needs.
//
// Only what is known safe is pinned here. connect-src still allows `https:`
// because the webview itself fetches user-chosen origins (huggingface.co from
// ModelDefaultsCard, preview file fetches); narrowing it needs a live smoke of
// each of those first. Plain `http:` is gone: provider and MCP traffic goes
// through the Tauri HTTP plugin, and the extensions' fetches to llama-server
// and the like stay on loopback (listed explicitly below). frame-src keeps
// `https:` for the browsing pane's iframe mode (a framed page has no IPC).
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

test('connect-src has no blanket http: but keeps the loopback hosts', () => {
  const t = tokens('connect-src')
  assert.ok(!t.includes('http:'), 'connect-src allows every http origin')
  for (const need of ['http://localhost:*', 'http://127.0.0.1:*', 'ws://localhost:*', 'ws://127.0.0.1:*']) {
    assert.ok(t.includes(need), `connect-src lost ${need}`)
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

// The static asset scope covers only the app's own folders. A file
// anywhere else (the Desktop, Downloads, another drive) loads over `asset:`
// only after `allow_asset_path` grants it, which applies the same
// sensitive-path and read-grant checks as the file commands; a static
// `$DOCUMENT/**` glob skipped those checks for everything under it.
test('the static asset scope holds only app folders', () => {
  const scope = conf.app.security.assetProtocol.scope
  assert.equal(scope.requireLiteralLeadingDot, true)
  for (const entry of scope.allow) {
    assert.match(entry, /^\$(APPDATA|APPCACHE)\//, `asset scope allows ${entry}`)
  }
  for (const platform of ['android', 'ios', 'linux', 'macos', 'windows']) {
    const other = JSON.parse(
      readFileSync(new URL(`../src-tauri/tauri.${platform}.conf.json`, import.meta.url), 'utf8')
    )
    assert.equal(other?.app?.security?.assetProtocol, undefined, `${platform} overrides the asset scope`)
  }
})
