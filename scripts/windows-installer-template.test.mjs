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
const uiPaths = [
  'flint-ui.nsh',
  'flint-ui-runtime.nsh',
  'flint-ui-pages.nsh',
  'flint-ui-uninstall.nsh',
].map((name) => new URL(`../src-tauri/installer/windows/${name}`, import.meta.url))

async function readInstallerUi() {
  return (await Promise.all(uiPaths.map((path) => readFile(path, 'utf8'))))
    .join('\n')
    .replace(/\r\n/g, '\n')
}

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

test('Windows installer ships the phone app the way the MSI does', async () => {
  // The generated template is rebuilt from the base at every build
  // (scripts/prepare-windows-installer.mjs), so the base is what has to list it.
  const base = await readFile(
    new URL('../src-tauri/tauri.bundle.windows.nsis.base.template', import.meta.url),
    'utf8'
  )
  const template = await readFile(templatePath, 'utf8')
  const line = /File \/a \/r "flint_workspace\\src-tauri\\resources\\mobile\\\*"/
  assert.match(base, line)
  const config = JSON.parse(
    await readFile(new URL('../src-tauri/tauri.windows.conf.json', import.meta.url), 'utf8')
  )

  // The NSIS bundler ignores `bundle.resources` for this template, so every
  // folder the config lists has to be installed by the template itself.
  assert.ok(config.bundle.resources.includes('resources/mobile/'))
  assert.match(
    template,
    /File \/a \/r "flint_workspace\\src-tauri\\resources\\mobile\\\*"/
  )
})

test('Windows installer recovers only Flint bundled processes and locked files', async () => {
  const template = await readFile(templatePath, 'utf8')

  assert.match(template, /StopBundledProcess "flint-llama-worker\.exe"/)
  assert.match(template, /UnlockBundledBinary "\$INSTDIR\\resources\\bin\\flint\.exe"/)
  assert.match(template, /UnlockBundledPattern "\$INSTDIR\\resources\\bin" "ggml\*\.dll"/)
  assert.match(template, /UnlockBundledBinary "\$INSTDIR\\bun\.exe"/)
  assert.doesNotMatch(template, /StopBundledProcess "jan-llama-worker\.exe"/)
})

test('Windows installer uses the Flint UI and every asset it embeds exists', async () => {
  const template = (await readFile(templatePath, 'utf8')).replace(/\r\n/g, '\n')
  const ui = await readInstallerUi()

  assert.match(template, /!define FLINT_WORKSPACE "flint_workspace"/)
  assert.match(template, /!include "flint_workspace\\src-tauri\\installer\\windows\\flint-ui\.nsh"/)
  for (const hook of ['FlintInstFilesShow', 'FlintInstFilesLeave']) {
    assert.match(template, new RegExp(`MUI_PAGE_CUSTOMFUNCTION_\\w+ ${hook}\\n`))
    assert.match(template, new RegExp(`MUI_PAGE_CUSTOMFUNCTION_\\w+ un\\.${hook}\\n`))
  }
  assert.match(template, /FLINT_UNINSTALL_CONFIRM_PAGE \$DeleteAppDataCheckboxState/)

  const roots = {
    FLINT_UI: '../src-tauri/installer/windows/',
    FLINT_INTER: '../web-app/public/fonts/inter/',
  }
  const extract = ui.match(/!macro _FlintExtract[\s\S]*?!macroend/)[0]
  const files = [...ui.matchAll(/"\$\{(FLINT_UI|FLINT_INTER)\}\\([^"]+)"/g)]
    .filter((m) => !m[2].includes('${'))
    .map((m) => roots[m[1]] + m[2].replaceAll('\\', '/'))
  for (const theme of ['light', 'dark']) {
    for (const scale of [100, 125, 150, 200]) {
      assert.match(ui, new RegExp(`_FlintExtract ${theme} ${scale}\\n`))
      for (const m of extract.matchAll(/\\\$\{scale\}\\([\w-]+\.bmp)"/g)) {
        files.push(`${roots.FLINT_UI}${theme}/${scale}/${m[1]}`)
      }
    }
  }
  assert.ok(files.length >= 34, `found ${files.length} embedded files`)
  await Promise.all(files.map((f) => readFile(new URL(f, import.meta.url))))
})
