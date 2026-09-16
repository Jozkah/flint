import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const templatePath = new URL('../src-tauri/tauri.bundle.windows.nsis.template', import.meta.url)
const internalWorkflowPath = new URL(
  '../.github/workflows/template-tauri-build-windows-x64.yml',
  import.meta.url
)
const externalWorkflowPath = new URL(
  '../.github/workflows/template-tauri-build-windows-x64-external.yml',
  import.meta.url
)

test('Windows installer resolves every source path from current workspace', async () => {
  const [template, internal, external] = await Promise.all([
    readFile(templatePath, 'utf8'),
    readFile(internalWorkflowPath, 'utf8'),
    readFile(externalWorkflowPath, 'utf8'),
  ])

  assert.doesNotMatch(template, /D:\\a\\jan\\jan/i)
  assert.match(template, /flint_workspace\\src-tauri\\icons\\icon\.ico/)
  for (const workflow of [internal, external]) {
    assert.match(workflow, /github\.workspace/)
    assert.match(workflow, /s\|flint_workspace\|/)
  }
})

test('Windows installer recovers only Flint bundled processes and locked files', async () => {
  const template = await readFile(templatePath, 'utf8')

  assert.match(template, /StopBundledProcess "flint-llama-worker\.exe"/)
  assert.match(template, /UnlockBundledBinary "\$INSTDIR\\resources\\bin\\flint\.exe"/)
  assert.match(template, /UnlockBundledPattern "\$INSTDIR\\resources\\bin" "ggml\*\.dll"/)
  assert.match(template, /UnlockBundledBinary "\$INSTDIR\\bun\.exe"/)
  assert.doesNotMatch(template, /StopBundledProcess "jan-llama-worker\.exe"/)
})
