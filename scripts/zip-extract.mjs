import fs, { mkdirSync } from 'fs'
import path from 'path'
import unzipper from 'unzipper'
import { assertSafeZipEntry } from './archive-extract-guard.mjs'

// Validates and extracts from the same central-directory listing, so what was
// checked is exactly what is written (a streaming extractor reads the local
// headers, which a crafted archive can make disagree with the directory).
export async function extractZipArchive(filePath, targetDir) {
  const archive = await unzipper.Open.file(filePath)
  for (const entry of archive.files) {
    assertSafeZipEntry(entry, targetDir)
  }
  const root = path.resolve(targetDir)
  for (const entry of archive.files) {
    const dest = path.resolve(root, entry.path.split('\\').join('/'))
    if (entry.type === 'Directory') {
      mkdirSync(dest, { recursive: true })
      continue
    }
    mkdirSync(path.dirname(dest), { recursive: true })
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest)
      entry.stream().on('error', reject).pipe(out).on('error', reject).on('finish', resolve)
    })
    const mode = (Number(entry.externalFileAttributes || 0) >>> 16) & 0o777
    if (mode) fs.chmodSync(dest, mode)
  }
}
