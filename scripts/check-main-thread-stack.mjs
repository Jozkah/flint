// Fails when a Windows executable reserves less than 8 MB for its main thread.
//
//   node scripts/check-main-thread-stack.mjs src-tauri/target/release/Flint-Desktop.exe
//
// Windows gives the main thread 1 MB unless the PE header asks for more, and the
// release build of Flint overflowed that on the first tool call (src-tauri/build.rs
// sets /STACK). A debug build never showed it, so nothing else would catch a
// regression: read the number out of the exe the build produced.
import { readFileSync } from 'node:fs'

export const REQUIRED_STACK_RESERVE = 8 * 1024 * 1024

/** SizeOfStackReserve from a PE32+ image's optional header. */
export function stackReserve(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const pe = view.getUint32(0x3c, true)
  if (view.getUint32(pe, true) !== 0x00004550) throw new Error('not a PE file')
  const optional = pe + 24
  if (view.getUint16(optional, true) !== 0x20b) throw new Error('not a PE32+ (64-bit) image')
  return Number(view.getBigUint64(optional + 72, true))
}

if (process.argv[1]?.endsWith('check-main-thread-stack.mjs')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node scripts/check-main-thread-stack.mjs <exe>')
    process.exit(2)
  }
  const reserve = stackReserve(readFileSync(file))
  const mb = (reserve / 1024 / 1024).toFixed(2)
  if (reserve < REQUIRED_STACK_RESERVE) {
    console.error(`${file} reserves ${mb} MB for its main thread; at least 8 MB is required (see src-tauri/build.rs).`)
    process.exit(1)
  }
  console.log(`${file} reserves ${mb} MB for its main thread.`)
}
