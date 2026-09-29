import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'
import { transformWindowsInstallerTemplate } from './prepare-windows-installer.mjs'

const basePath = new URL('../src-tauri/tauri.bundle.windows.nsis.base.template', import.meta.url)
const windowsConfigPath = new URL('../src-tauri/tauri.windows.conf.json', import.meta.url)
const uiPaths = [
  'flint-ui.nsh',
  'flint-ui-runtime.nsh',
  'flint-ui-pages.nsh',
  'flint-ui-uninstall.nsh',
].map((name) => new URL(`../src-tauri/installer/windows/${name}`, import.meta.url))

async function readInstallerUi() {
  return (await Promise.all(uiPaths.map((path) => readFile(path, 'utf8')))).join('\n')
}

test('Windows NSIS build is permanently wired to the Flint template', async () => {
  const config = JSON.parse(await readFile(windowsConfigPath, 'utf8'))
  assert.equal(config.bundle.windows.nsis.template, 'tauri.bundle.windows.nsis.template')
  assert.equal(config.bundle.windows.nsis.installerIcon, 'icons/icon.ico')
})

test('installer template transformation creates the complete Flint wizard', async () => {
  const base = await readFile(basePath, 'utf8')
  const generated = transformWindowsInstallerTemplate(base, base)

  for (const macro of [
    'FLINT_WELCOME_PAGE',
    'FLINT_OPTIONS_PAGE',
    'FLINT_FINISH_PAGE',
    'FLINT_UNINSTALL_CONFIRM_PAGE',
    'FLINT_UNINSTALL_FINISH_PAGE',
  ]) {
    assert.match(generated, new RegExp(`!insertmacro ${macro}`))
  }
  assert.match(generated, /Call FlintMaintenance/)
  assert.doesNotMatch(generated, /always run in passive mode/)
  assert.doesNotMatch(generated, /flint_workspace/)
  assert.match(generated, /\$FlintDesktopShortcutState = 1/)
  assert.match(generated, /Interactive installs always[\s\S]*completion page, which exclusively owns app launch/)
  assert.doesNotMatch(
    generated,
    /\$\{ElseIf\} \$FlintLaunchState = 1[\s\S]{0,120}Call RunMainBinary/
  )
  assert.match(generated, /SetAutoClose false/)
})

test('template preparation preserves Windows ARM64 retargeting', async () => {
  const base = await readFile(basePath, 'utf8')
  const armCurrent = base
    .replace('!define ARCH "x64"', '!define ARCH "arm64"')
    .replaceAll('\\nsis\\x64\\', '\\nsis\\arm64\\')
    .replaceAll('x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc')
    .replaceAll('\\VC\\Runtimes\\x64', '\\VC\\Runtimes\\arm64')
    .replaceAll('VC_RuntimeMinimumVSU_amd64', 'VC_RuntimeMinimumVSU_arm64')

  const generated = transformWindowsInstallerTemplate(base, armCurrent)
  assert.match(generated, /!define ARCH "arm64"/)
  assert.match(generated, /\\nsis\\arm64\\/)
  assert.match(generated, /aarch64-pc-windows-msvc/)
  assert.match(generated, /\\VC\\Runtimes\\arm64/)
  assert.match(generated, /VC_RuntimeMinimumVSU_arm64/)
  assert.doesNotMatch(generated, /x86_64-pc-windows-msvc/)
})

test('Flint UI uses the real app icon, Inter and the expected page copy', async () => {
  const ui = await readInstallerUi()
  assert.match(ui, /Resource 103 is produced from src-tauri\/icons\/icon\.ico/)
  assert.match(ui, /LoadImageW\(p r0, p 103/)
  assert.match(ui, /WM_SETICON/)
  assert.match(ui, /Inter_18pt-Regular\.ttf/)
  assert.match(ui, /Inter_18pt-Medium\.ttf/)
  assert.match(ui, /Inter_18pt-SemiBold\.ttf/)
  assert.match(ui, /Install Flint/)
  assert.match(ui, /Choose installation options/)
  assert.match(ui, /Flint is ready/)
  assert.match(ui, /\$FlintLaunchState = 1[\s\S]*"Launch Flint" FlintFinishLaunch/)
  assert.match(ui, /"Finish" FlintFinishClose/)
})

test('every bitmap used by the custom UI exists at every theme and DPI', async () => {
  const files = []
  for (const theme of ['light', 'dark']) {
    for (const scale of [100, 125, 150, 200]) {
      for (const asset of ['btn-uninstall.bmp', 'btn-cancel.bmp', 'switch-on.bmp', 'switch-off.bmp']) {
        files.push(
          new URL(`../src-tauri/installer/windows/${theme}/${scale}/${asset}`, import.meta.url)
        )
      }
    }
  }
  await Promise.all(files.map((file) => access(file)))
  assert.equal(files.length, 32)
})
