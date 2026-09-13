/**
 * Is a bundled sidecar a real program for this machine, or a placeholder?
 *
 * `scripts/stub-tauri-resources.sh` creates zero-byte files at exactly the paths
 * the Tauri build script validates, because that build script only checks that a
 * path exists. That is the right trade for a compile-only run, and it is a trap
 * for a packaging run: the stubs survive in `src-tauri/resources/bin`, the
 * bundler copies them without complaint, and the installer that comes out is
 * indistinguishable from a real one until a user launches it and the sidecar
 * does nothing. A macOS `.app` was shipped that way.
 *
 * Existence is therefore not the question. This module asks the question that
 * matters -- is this file an executable image, for this operating system, for
 * this processor -- by reading the bytes the loader itself reads.
 *
 * Header parsing is deliberately hand-rolled and small. The alternative is a
 * dependency that must be installed before a build can check whether it is
 * about to ship placeholders, which puts the check downstream of the failure it
 * exists to catch.
 */

import { createHash } from 'node:crypto'
import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { readFileSync } from 'node:fs'

/** PE `IMAGE_FILE_MACHINE_*`, ELF `e_machine`, Mach-O `cputype`, by triple arch. */
const ARCH = {
  x86_64: { pe: 0x8664, elf: 0x3e, macho: 0x01000007 },
  i686: { pe: 0x014c, elf: 0x03, macho: 0x00000007 },
  aarch64: { pe: 0xaa64, elf: 0xb7, macho: 0x0100000c },
  armv7: { pe: 0x01c4, elf: 0x28, macho: 0x0000000c },
}

/** The architecture and OS a Rust target triple names. */
export function parseTriple(triple) {
  const [arch, , os] = triple.split('-')
  const family = os === 'windows' ? 'windows' : os === 'darwin' ? 'darwin' : 'linux'
  return { arch, family }
}

/**
 * What kind of image is this, and for which processor?
 *
 * Returns `{ format, machine }` for a recognised image and `null` for anything
 * else -- a shell script with a `.exe` name lands here, and lands as `null`,
 * which is the entire point.
 */
export function identify(head) {
  // PE: "MZ", then a file offset at 0x3c pointing at "PE\0\0" and the machine.
  if (head.length >= 0x40 && head[0] === 0x4d && head[1] === 0x5a) {
    const lfanew = head.readUInt32LE(0x3c)
    if (
      lfanew + 6 <= head.length &&
      head[lfanew] === 0x50 &&
      head[lfanew + 1] === 0x45 &&
      head[lfanew + 2] === 0 &&
      head[lfanew + 3] === 0
    ) {
      return { format: 'pe', machine: head.readUInt16LE(lfanew + 4) }
    }
    // "MZ" with no PE header is a DOS stub, not a Windows program.
    return { format: 'mz-only', machine: null }
  }

  // ELF: 0x7F "ELF", then `e_machine` at 0x12 (little-endian is EI_DATA 1).
  if (
    head.length >= 0x14 &&
    head[0] === 0x7f &&
    head[1] === 0x45 &&
    head[2] === 0x4c &&
    head[3] === 0x46
  ) {
    const le = head[5] !== 2
    return {
      format: 'elf',
      machine: le ? head.readUInt16LE(0x12) : head.readUInt16BE(0x12),
    }
  }

  // Mach-O, thin (0xfeedfacf / 0xfeedface) or universal (0xcafebabe).
  if (head.length >= 8) {
    const be = head.readUInt32BE(0)
    const le = head.readUInt32LE(0)
    if (be === 0xcafebabe) return { format: 'macho-universal', machine: null }
    if (le === 0xfeedfacf || le === 0xfeedface) {
      return { format: 'macho', machine: head.readUInt32LE(4) }
    }
    if (be === 0xfeedfacf || be === 0xfeedface) {
      return { format: 'macho', machine: head.readUInt32BE(4) }
    }
  }

  return null
}

/** The image format a target family is loaded from. */
const FORMAT_FOR = { windows: 'pe', darwin: 'macho', linux: 'elf' }

/**
 * Inspect one file against a target triple.
 *
 * Never throws for a bad file: a missing, empty or nonsense binary is a result
 * to report alongside every other one, not an exception that hides the rest of
 * the report behind whichever path happened to be checked first.
 */
export function inspect(path, triple, { requireExecutable = true } = {}) {
  const { arch, family } = parseTriple(triple)
  const result = { path, triple, ok: false, problems: [] }

  let stat
  try {
    stat = statSync(path)
  } catch {
    result.problems.push('missing')
    return result
  }
  if (!stat.isFile()) {
    result.problems.push('not a regular file')
    return result
  }

  result.size = stat.size
  if (stat.size === 0) {
    // The stub case, named plainly because this is the failure that shipped.
    result.problems.push('empty (0 bytes) -- this is a build stub, not a binary')
    return result
  }

  const head = Buffer.alloc(Math.min(4096, stat.size))
  const fd = openSync(path, 'r')
  try {
    readSync(fd, head, 0, head.length, 0)
  } finally {
    closeSync(fd)
  }

  result.sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')

  const image = identify(head)
  const expectedFormat = FORMAT_FOR[family]
  if (image === null) {
    const text = head.subarray(0, 2).toString('latin1') === '#!' ? ' (it is a script)' : ''
    result.problems.push(`not an executable image${text}; expected ${expectedFormat}`)
    return result
  }
  result.format = image.format

  if (image.format === 'mz-only') {
    result.problems.push('has a DOS "MZ" header but no PE header')
    return result
  }
  if (image.format !== expectedFormat && image.format !== 'macho-universal') {
    result.problems.push(`is ${image.format}, but ${triple} loads ${expectedFormat}`)
    return result
  }

  // A universal Mach-O carries several architectures; the slice check is a
  // different piece of work and the format check has already done the job that
  // catches a stub, so it is reported as unverified rather than claimed.
  if (image.format === 'macho-universal') {
    result.machineChecked = false
  } else {
    const want = ARCH[arch]?.[image.format === 'pe' ? 'pe' : image.format === 'elf' ? 'elf' : 'macho']
    if (want === undefined) {
      result.machineChecked = false
    } else if (image.machine !== want) {
      result.problems.push(
        `is built for machine 0x${image.machine.toString(16)}, not ${arch} (0x${want.toString(16)})`
      )
      return result
    } else {
      result.machineChecked = true
    }
  }

  // Windows carries no execute bit; the PE header is the whole answer there.
  if (requireExecutable && family !== 'windows' && !(stat.mode & 0o111)) {
    result.problems.push('is not marked executable')
    return result
  }

  result.ok = true
  return result
}
