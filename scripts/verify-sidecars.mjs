// Verify every sidecar before trusting it: size, hash, PE header, architecture.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const BIN = 'src-tauri/resources/bin'

/** IMAGE_FILE_MACHINE values we care about. */
const MACHINE = { 0x8664: 'x86_64', 0x014c: 'x86', 0xaa64: 'arm64' }

/**
 * Read a PE header. Returns null when the file is not a PE image at all --
 * which is exactly what a placeholder or a truncated download looks like.
 */
function pe(path) {
  const buf = readFileSync(path)
  if (buf.length < 0x40) return null
  if (buf.readUInt16LE(0) !== 0x5a4d) return null // "MZ"
  const off = buf.readUInt32LE(0x3c)
  if (off + 6 > buf.length) return null
  if (buf.readUInt32LE(off) !== 0x00004550) return null // "PE\0\0"
  return {
    machine: MACHINE[buf.readUInt16LE(off + 4)] ?? `0x${buf.readUInt16LE(off + 4).toString(16)}`,
    sections: buf.readUInt16LE(off + 6),
  }
}

let failed = 0
const bad = (m) => {
  console.log('  FAIL', m)
  failed += 1
}

const files = existsSync(BIN) ? readdirSync(BIN) : []
console.log(`${BIN}: ${files.length} entries\n`)

for (const name of files.sort()) {
  const path = join(BIN, name)
  const st = statSync(path)
  if (st.isDirectory()) continue
  const bytes = st.size
  const sha = createHash('sha256').update(readFileSync(path)).digest('hex')
  const header = /\.(exe|dll)$/i.test(name) ? pe(path) : null

  console.log(name)
  console.log(`  size    ${bytes.toLocaleString()} bytes`)
  console.log(`  sha256  ${sha}`)
  if (header) console.log(`  pe      ${header.machine}, ${header.sections} sections`)

  if (bytes === 0) bad(`${name} is zero bytes`)
  if (/\.(exe|dll)$/i.test(name)) {
    if (!header) bad(`${name} is not a PE image -- placeholder or truncated`)
    else if (header.machine !== 'x86_64') bad(`${name} is ${header.machine}, not x86_64`)
    // A stub is zero bytes or a few hundred; a real artifact is at least tens
    // of kilobytes. The floor is deliberately low because it has to clear
    // `ggml.dll`, which is a genuine 86KB dispatch shim in front of the
    // per-architecture backends -- the PE and architecture checks above are
    // what actually distinguish a real binary from a placeholder.
    if (bytes < 20_000) bad(`${name} is implausibly small for a real binary`)
  }
  console.log()
}

// A harmless version probe on the two that support one.
for (const [name, args] of [
  ['bun-x86_64-pc-windows-msvc.exe', ['--version']],
  ['uv-x86_64-pc-windows-msvc.exe', ['--version']],
]) {
  const path = join(BIN, name)
  if (!existsSync(path)) {
    bad(`${name} is missing`)
    continue
  }
  try {
    const out = execFileSync(path, args, { encoding: 'utf8', timeout: 30_000 }).trim()
    console.log(`${name} ${args.join(' ')} -> ${out}`)
  } catch (e) {
    bad(`${name} ${args.join(' ')} failed: ${e.message.split('\n')[0]}`)
  }
}

console.log(failed ? `\nRESULT: ${failed} problem(s)` : '\nRESULT: all sidecars verified')
process.exitCode = failed ? 1 : 0
