import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The gate that keeps build stubs out of an installer.
 *
 * A zero-byte file at `resources/bin/jan.exe` satisfies everything the Tauri
 * build script asks of it, and a macOS `.app` was shipped whose sidecars were
 * exactly that. So the interesting cases here are the forgeries, not the happy
 * path: an empty file, a shell script wearing an `.exe` name, and a binary for
 * the wrong processor.
 *
 * The Windows cases are synthesised rather than taken from a real build. A PE
 * header is a fixed layout and the parser reads four fields of it, so bytes
 * assembled here exercise the same code the real thing would -- and they let
 * the Windows behaviour be tested off Windows, which is the only way this check
 * is covered before the build it guards.
 */

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const MODULE = resolve(HERE, '../../../scripts/sidecar-integrity.mjs')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sidecar: any

const WIN = 'x86_64-pc-windows-msvc'
const LINUX = 'x86_64-unknown-linux-gnu'

/** A minimal but structurally real PE image for `machine`. */
function pe(machine: number): Buffer {
  const buf = Buffer.alloc(512)
  buf.write('MZ', 0, 'latin1')
  const lfanew = 0x80
  buf.writeUInt32LE(lfanew, 0x3c)
  buf.write('PE\0\0', lfanew, 'latin1')
  buf.writeUInt16LE(machine, lfanew + 4)
  return buf
}

/** A minimal but structurally real 64-bit little-endian ELF for `machine`. */
function elf(machine: number): Buffer {
  const buf = Buffer.alloc(256)
  buf[0] = 0x7f
  buf.write('ELF', 1, 'latin1')
  buf[4] = 2 // ELFCLASS64
  buf[5] = 1 // ELFDATA2LSB
  buf.writeUInt16LE(2, 0x10) // ET_EXEC
  buf.writeUInt16LE(machine, 0x12)
  return buf
}

let dir: string
const write = (name: string, bytes: Buffer | string, mode = 0o755) => {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  chmodSync(path, mode)
  return path
}

beforeAll(async () => {
  sidecar = await import(MODULE)
  dir = mkdtempSync(join(tmpdir(), 'sidecar-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('sidecar integrity', () => {
  it('accepts a Windows x86_64 PE for a Windows x86_64 target', () => {
    const r = sidecar.inspect(write('jan.exe', pe(0x8664)), WIN)
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.format).toBe('pe')
    expect(r.architectureVerified ?? r.machineChecked).toBe(true)
  })

  it('rejects an arm64 PE for an x86_64 Windows target', () => {
    const r = sidecar.inspect(write('arm.exe', pe(0xaa64)), WIN)
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toMatch(/machine 0xaa64.*x86_64/)
  })

  it('accepts an x86_64 PE for an arm64 Windows target only when it matches', () => {
    const path = write('arm-ok.exe', pe(0xaa64))
    expect(sidecar.inspect(path, 'aarch64-pc-windows-msvc').ok).toBe(true)
  })

  // The failure that shipped: the file exists, so every existence check passes.
  it('rejects a zero-byte stub and says it is a stub', () => {
    const r = sidecar.inspect(write('stub.exe', Buffer.alloc(0)), WIN)
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toMatch(/empty \(0 bytes\).*stub/)
  })

  it('rejects a shell script renamed to .exe', () => {
    const r = sidecar.inspect(write('script.exe', '#!/bin/sh\necho hi\n'), WIN)
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toMatch(/not an executable image.*script/)
  })

  it('rejects a DOS stub carrying no PE header', () => {
    const buf = Buffer.alloc(256)
    buf.write('MZ', 0, 'latin1')
    buf.writeUInt32LE(0x80, 0x3c)
    const r = sidecar.inspect(write('dos.exe', buf), WIN)
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toMatch(/no PE header/)
  })

  it('rejects an ELF binary bundled for Windows', () => {
    const r = sidecar.inspect(write('linux-in-win.exe', elf(0x3e)), WIN)
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toMatch(/is elf, but .* loads pe/)
  })

  it('rejects a PE bundled for Linux', () => {
    const r = sidecar.inspect(write('win-in-linux', pe(0x8664)), LINUX)
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toMatch(/is pe, but .* loads elf/)
  })

  it('rejects a missing file without throwing', () => {
    const r = sidecar.inspect(join(dir, 'absent.exe'), WIN)
    expect(r.ok).toBe(false)
    expect(r.problems).toEqual(['missing'])
  })

  it('requires the execute bit on unix but not on Windows', () => {
    const notExec = write('plain', elf(0x3e), 0o644)
    expect(sidecar.inspect(notExec, LINUX).ok).toBe(false)
    // The same mode is irrelevant to a PE: Windows carries no execute bit.
    const winPlain = write('plain.exe', pe(0x8664), 0o644)
    expect(sidecar.inspect(winPlain, WIN).ok).toBe(true)
  })

  it('does not require the execute bit when the caller says it is a library', () => {
    const lib = write('ggml.so', elf(0x3e), 0o644)
    expect(sidecar.inspect(lib, LINUX, { requireExecutable: false }).ok).toBe(true)
  })

  it('reports a sha256 and a size for anything it can read', () => {
    const r = sidecar.inspect(write('hash.exe', pe(0x8664)), WIN)
    expect(r.size).toBe(512)
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reads the OS and architecture out of a target triple', () => {
    expect(sidecar.parseTriple(WIN)).toEqual({ arch: 'x86_64', family: 'windows' })
    expect(sidecar.parseTriple('aarch64-apple-darwin')).toEqual({
      arch: 'aarch64',
      family: 'darwin',
    })
    expect(sidecar.parseTriple(LINUX)).toEqual({ arch: 'x86_64', family: 'linux' })
  })
})
