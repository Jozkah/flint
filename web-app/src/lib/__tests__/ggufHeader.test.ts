import { describe, expect, it } from 'vitest'
import { parseGgufArchitecture } from '../ggufHeader'
import {
  kvArchitectureFromGguf,
  kvCacheBytesFromArchitecture,
} from '../modelCompatibility'

class Writer {
  private parts: number[] = []
  u32(v: number) {
    for (let i = 0; i < 4; i++) this.parts.push((v >>> (8 * i)) & 0xff)
  }
  u64(v: number) {
    this.u32(v % 2 ** 32)
    this.u32(Math.floor(v / 2 ** 32))
  }
  str(text: string) {
    const bytes = new TextEncoder().encode(text)
    this.u64(bytes.length)
    for (const b of bytes) this.parts.push(b)
  }
  bytes() {
    return new Uint8Array(this.parts)
  }
}

const STRING = 8
const ARRAY = 9
const U32 = 4
const F32 = 6

/** A header shaped like a real one: general.*, the arch keys, then the tokenizer. */
function header(options: { arch?: string; truncateAt?: number } = {}) {
  const arch = options.arch ?? 'llama'
  const w = new Writer()
  w.u32(0x46554747)
  w.u32(3)
  w.u64(0)
  w.u64(0) // patched below with the entry count
  const entries: Array<() => void> = [
    () => {
      w.str('general.architecture')
      w.u32(STRING)
      w.str(arch)
    },
    () => {
      w.str('general.name')
      w.u32(STRING)
      w.str('Example')
    },
    () => {
      w.str(`${arch}.context_length`)
      w.u32(U32)
      w.u32(8192)
    },
    () => {
      w.str(`${arch}.embedding_length`)
      w.u32(U32)
      w.u32(4096)
    },
    () => {
      w.str(`${arch}.block_count`)
      w.u32(U32)
      w.u32(32)
    },
    () => {
      w.str(`${arch}.attention.head_count`)
      w.u32(U32)
      w.u32(32)
    },
    () => {
      w.str(`${arch}.attention.head_count_kv`)
      w.u32(U32)
      w.u32(8)
    },
    () => {
      w.str(`${arch}.rope.freq_base`)
      w.u32(F32)
      w.u32(0)
    },
    () => {
      w.str('tokenizer.ggml.tokens')
      w.u32(ARRAY)
      w.u32(STRING)
      w.u64(2)
      w.str('a')
      w.str('b')
    },
  ]
  for (const write of entries) write()
  const out = w.bytes()
  // Magic, version, tensor count, then the key/value count at offset 16.
  new DataView(out.buffer).setBigUint64(16, BigInt(entries.length), true)
  return options.truncateAt ? out.subarray(0, options.truncateAt) : out
}

describe('parseGgufArchitecture', () => {
  it('reads the architecture keys and stops at the tokenizer', () => {
    expect(parseGgufArchitecture(header())).toEqual({
      'general.architecture': 'llama',
      'llama.context_length': '8192',
      'llama.embedding_length': '4096',
      'llama.block_count': '32',
      'llama.attention.head_count': '32',
      'llama.attention.head_count_kv': '8',
    })
  })

  it('feeds the same KV size the plugin computes', () => {
    const arch = kvArchitectureFromGguf(parseGgufArchitecture(header()))!
    // 32 layers x 8 KV heads x (128 key + 128 value) x 2 bytes x 8192 tokens
    expect(kvCacheBytesFromArchitecture(arch, 8192).bytes).toBe(1024 ** 3)
  })

  it('returns what it has when the header is cut short after the keys', () => {
    const full = header()
    const cut = parseGgufArchitecture(full.subarray(0, full.length - 30))
    expect(cut?.['llama.block_count']).toBe('32')
  })

  it('returns null when it is cut before the architecture is named', () => {
    expect(parseGgufArchitecture(header({ truncateAt: 30 }))).toBeNull()
  })

  it('returns null for anything that is not a GGUF header', () => {
    expect(parseGgufArchitecture(new Uint8Array(64))).toBeNull()
    expect(parseGgufArchitecture(new TextEncoder().encode('<html>'))).toBeNull()
  })
})
