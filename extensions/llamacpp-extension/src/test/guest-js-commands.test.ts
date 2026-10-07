import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Every command the llamacpp guest-js layer invokes must be one the plugin
// registers. `getDevices` kept invoking `get_devices` after that command was
// removed in favour of `engine_devices`, and still shipped in the package's
// public API (#61).
const PLUGIN = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'src-tauri',
  'plugins',
  'tauri-plugin-llamacpp'
)

function registeredCommands(): Set<string> {
  const build = readFileSync(join(PLUGIN, 'build.rs'), 'utf8')
  const list = build.match(/const COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/)
  if (!list) throw new Error('COMMANDS not found in build.rs')
  return new Set(Array.from(list[1].matchAll(/"([a-z0-9_]+)"/g), (m) => m[1]))
}

function invokedCommands(): string[] {
  const guest = readFileSync(join(PLUGIN, 'guest-js', 'index.ts'), 'utf8')
  return Array.from(guest.matchAll(/plugin:llamacpp\|([a-z0-9_]+)/g), (m) => m[1])
}

describe('llamacpp guest-js commands', () => {
  it('invokes only commands the plugin registers', () => {
    const registered = registeredCommands()
    const missing = invokedCommands().filter((c) => !registered.has(c))
    expect(missing).toEqual([])
  })

  it('no longer exports the removed getDevices wrapper', () => {
    const guest = readFileSync(join(PLUGIN, 'guest-js', 'index.ts'), 'utf8')
    expect(guest).not.toMatch(/export async function getDevices\b/)
  })
})
