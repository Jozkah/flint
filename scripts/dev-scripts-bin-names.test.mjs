import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// #52: the dev scripts and the TUI guide built `--bin jan`, a target that no
// longer exists. Every `--bin <name>` they use must be a declared [[bin]].
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const cargo = read('../src-tauri/Cargo.toml')
const bins = new Set(
  [...cargo.matchAll(/\[\[bin\]\][^[]*?name\s*=\s*"([^"]+)"/g)].map((m) => m[1])
)

const buildTui = read('../build-tui.sh')
const binName = buildTui.match(/^BIN_NAME="([^"]+)"/m)?.[1]

test('the CLI [[bin]] targets are found', () => {
  assert.ok(bins.has('flint'), `bins: ${[...bins]}`)
})

test('build-tui.sh builds and copies a declared bin', () => {
  assert.ok(binName && bins.has(binName), `BIN_NAME=${binName}`)
  for (const [, name] of buildTui.matchAll(/--bin\s+"?([\w$-]+)"?/g)) {
    const resolved = name === '$BIN_NAME' ? binName : name
    assert.ok(bins.has(resolved), `--bin ${resolved} is not a [[bin]]`)
  }
  assert.doesNotMatch(buildTui, /target\/\$target_dir\/jan\b/)
})

test('jan-agent.sh launches the flint binary', () => {
  const launcher = read('../jan-agent.sh')
  // build-tui.sh installs the CLI to ~/.local/bin/flint; FLINT_BIN overrides it.
  assert.match(launcher, /\.local\/bin\/flint\}"/)
  assert.match(launcher, /FLINT_BIN/)
  assert.doesNotMatch(launcher, /\/bin\/jan"/)
})

test('AGENT-TUI.md only builds declared bins', () => {
  const guide = read('../AGENT-TUI.md')
  for (const [, name] of guide.matchAll(/--bin\s+([\w-]+)/g)) {
    assert.ok(bins.has(name), `--bin ${name} is not a [[bin]]`)
  }
  assert.doesNotMatch(guide, /src\/bin\/jan\.rs/)
})
