/**
 * Reads the architecture keys out of the start of a GGUF file.
 *
 * A GGUF file opens with a key/value table before any tensor data. The keys
 * that decide how much memory the context needs (layers, KV heads, head size,
 * trained context, sliding window) sit in it as small integers, ahead of the
 * tokenizer's large arrays. Reading them lets Discover size the KV cache
 * exactly from a single ranged request instead of guessing from the file size.
 *
 * Returns the values as strings keyed like the plugin's metadata map, so
 * `kvArchitectureFromGguf` can consume them unchanged, or null when the header
 * is not GGUF or ends before the architecture keys.
 */

const MAGIC = 0x46554747 // "GGUF", little-endian

const T = {
  U8: 0,
  I8: 1,
  U16: 2,
  I16: 3,
  U32: 4,
  I32: 5,
  F32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  U64: 10,
  I64: 11,
  F64: 12,
} as const

const SCALAR_SIZE: Record<number, number> = {
  [T.U8]: 1,
  [T.I8]: 1,
  [T.U16]: 2,
  [T.I16]: 2,
  [T.U32]: 4,
  [T.I32]: 4,
  [T.F32]: 4,
  [T.BOOL]: 1,
  [T.U64]: 8,
  [T.I64]: 8,
  [T.F64]: 8,
}

/** A key this reader needs, given the architecture the file names. */
function wanted(key: string, arch: string | null): boolean {
  if (key === 'general.architecture') return true
  if (!arch || !key.startsWith(`${arch}.`)) return false
  return /\.(block_count|context_length|embedding_length|attention\.(head_count|head_count_kv|key_length|value_length|sliding_window))$/.test(
    key
  )
}

class Truncated extends Error {}

export function parseGgufArchitecture(
  bytes: Uint8Array
): Record<string, string> | null {
  if (bytes.byteLength < 24) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== MAGIC) return null
  const version = view.getUint32(4, true)
  if (version < 2 || version > 3) return null

  let at = 8 + 8 // version, tensor count
  const kvCount = Number(view.getBigUint64(at, true))
  at += 8

  const need = (n: number) => {
    if (at + n > bytes.byteLength) throw new Truncated()
  }
  const u32 = () => {
    need(4)
    const v = view.getUint32(at, true)
    at += 4
    return v
  }
  const u64 = () => {
    need(8)
    const v = Number(view.getBigUint64(at, true))
    at += 8
    return v
  }
  const string = () => {
    const length = u64()
    if (length > 1 << 20) throw new Truncated()
    need(length)
    const text = new TextDecoder().decode(bytes.subarray(at, at + length))
    at += length
    return text
  }
  const scalar = (type: number): number | null => {
    const size = SCALAR_SIZE[type]
    if (size === undefined) throw new Truncated()
    need(size)
    let value: number | null = null
    switch (type) {
      case T.U8:
        value = view.getUint8(at)
        break
      case T.I8:
        value = view.getInt8(at)
        break
      case T.U16:
        value = view.getUint16(at, true)
        break
      case T.I16:
        value = view.getInt16(at, true)
        break
      case T.U32:
        value = view.getUint32(at, true)
        break
      case T.I32:
        value = view.getInt32(at, true)
        break
      case T.U64:
        value = Number(view.getBigUint64(at, true))
        break
      case T.I64:
        value = Number(view.getBigInt64(at, true))
        break
      default:
        value = null // floats and bools carry nothing this reader needs
    }
    at += size
    return value
  }
  const skipArray = () => {
    const elementType = u32()
    const length = u64()
    if (elementType === T.STRING) {
      for (let i = 0; i < length; i++) string()
    } else if (elementType === T.ARRAY) {
      throw new Truncated()
    } else {
      const size = SCALAR_SIZE[elementType]
      if (size === undefined) throw new Truncated()
      need(size * length)
      at += size * length
    }
  }

  const found: Record<string, string> = {}
  let arch: string | null = null
  try {
    for (let i = 0; i < kvCount; i++) {
      const key = string()
      // The tokenizer's arrays are megabytes long and come after the
      // architecture keys, so there is nothing further to read.
      if (key.startsWith('tokenizer.')) break
      const type = u32()
      if (type === T.STRING) {
        const value = string()
        if (key === 'general.architecture') {
          arch = value
          found[key] = value
        }
      } else if (type === T.ARRAY) {
        skipArray()
      } else {
        const value = scalar(type)
        if (value !== null && wanted(key, arch)) found[key] = String(value)
      }
    }
  } catch (error) {
    if (!(error instanceof Truncated)) throw error
  }
  return found['general.architecture'] ? found : null
}
