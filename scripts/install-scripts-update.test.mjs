import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// #107: the CLI self-updater (`jan update`, core/cli/updater.rs) was removed.
// The install scripts must not send users to a command that no longer exists.
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const flint = read('../src-tauri/src/bin/flint.rs')
const scripts = {
  'install-jan-agent.sh': read('./install-jan-agent.sh'),
  'install-jan-agent.ps1': read('./install-jan-agent.ps1'),
}

test('install scripts only mention an update command the CLI has', () => {
  const cliHasUpdate = /^\s*Update\b/m.test(flint)
  for (const [name, text] of Object.entries(scripts)) {
    assert.doesNotMatch(text, /core[\\/]cli[\\/]updater\.rs/, `${name} cites the deleted updater`)
    if (!cliHasUpdate) {
      assert.doesNotMatch(text, /`(?:jan|flint) update`/, `${name} documents a removed command`)
    }
  }
})

// janhq/jan#9096, #9139: SetEnvironmentVariable('Path', ...) rewrites the user
// PATH as REG_SZ from an expanded read, flattening every %VAR% entry.
test('the PowerShell installer keeps the user PATH unexpanded and typed', () => {
  const ps1 = scripts['install-jan-agent.ps1']
  assert.doesNotMatch(ps1, /SetEnvironmentVariable\('Path'/)
  assert.doesNotMatch(ps1, /GetEnvironmentVariable\('Path'/)
  assert.match(ps1, /DoNotExpandEnvironmentNames/)
  assert.match(ps1, /RegistryValueKind\]::ExpandString/)
})
