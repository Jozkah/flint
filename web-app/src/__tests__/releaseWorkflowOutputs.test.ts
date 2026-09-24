import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * #142: the macOS and Windows release templates still set step outputs with
 * the deprecated `::set-output` command, which GitHub intends to remove; the
 * upload steps read those outputs. Workflows have no other test harness, so
 * the files are checked as text. Paths are resolved from this file.
 */
const HERE = resolve(fileURLToPath(import.meta.url), '..')
const WORKFLOWS = resolve(HERE, '../../../.github/workflows')

describe.each([
  ['template-tauri-build-macos.yml', ['MAC_UNIVERSAL_SIG', 'FILE_NAME', 'DMG_NAME', 'TAR_NAME']],
  ['template-tauri-build-windows-x64.yml', ['WIN_SIG', 'FILE_NAME', 'MSI_FILE_NAME']],
])('%s', (file, outputs) => {
  const text = readFileSync(resolve(WORKFLOWS, file), 'utf8')

  it('does not use the deprecated ::set-output command', () => {
    expect(text).not.toContain('::set-output')
  })

  it.each(outputs)('writes %s to $GITHUB_OUTPUT', (name) => {
    expect(text).toMatch(new RegExp(`echo "${name}=\\$\\w+" >> \\$GITHUB_OUTPUT`))
  })
})
