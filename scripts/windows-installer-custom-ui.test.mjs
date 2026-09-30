import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'
import { transformWindowsInstallerTemplate } from './prepare-windows-installer.mjs'

const basePath = new URL('../src-tauri/tauri.bundle.windows.nsis.base.template', import.meta.url)
const windowsConfigPath = new URL('../src-tauri/tauri.windows.conf.json', import.meta.url)
const tauriConfigPath = new URL('../src-tauri/tauri.conf.json', import.meta.url)
const uiPaths = [
  'flint-ui.nsh',
  'flint-ui-runtime.nsh',
  'flint-ui-pages.nsh',
  'flint-ui-uninstall.nsh',
].map((name) => new URL(`../src-tauri/installer/windows/${name}`, import.meta.url))

async function readInstallerUi() {
  return (await Promise.all(uiPaths.map((path) => readFile(path, 'utf8')))).join('\n')
}

async function localTemplateDefaults() {
  const config = JSON.parse(await readFile(tauriConfigPath, 'utf8'))
  const parts = String(config.version).split('-', 1)[0].split('.')
  return {
    productName: config.productName,
    version: config.version,
    versionWithBuild: [...parts, '0', '0', '0', '0'].slice(0, 4).join('.'),
    mainBinaryName: config.mainBinaryName ?? config.productName,
    bundleId: config.identifier,
  }
}

test('Windows NSIS build is permanently wired to the Flint template', async () => {
  const config = JSON.parse(await readFile(windowsConfigPath, 'utf8'))
  assert.equal(config.bundle.windows.nsis.template, 'tauri.bundle.windows.nsis.template')
  assert.equal(config.bundle.windows.nsis.installerIcon, 'icons/icon.ico')
})

test('installer template transformation creates the complete Flint wizard', async () => {
  const base = await readFile(basePath, 'utf8')
  const generated = transformWindowsInstallerTemplate(base, base, await localTemplateDefaults())

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
  assert.doesNotMatch(generated, /jan_(?:productname|version|build|mainbinaryname|bundleid)/)
  assert.match(generated, /!define PRODUCTNAME "Flint"/)
  assert.match(generated, /!define MAINBINARYNAME "Flint-Desktop"/)
  assert.match(generated, /!define VERSION "0\.9\.0"/)
  assert.match(generated, /!define VERSIONWITHBUILD "0\.9\.0\.0"/)
  assert.match(generated, /!define BUNDLEID "jan\.ai\.app"/)
  assert.match(
    generated,
    /!define ADDITIONALPLUGINSPATH "\{\{additional_plugins_path\}\}"/
  )
  assert.doesNotMatch(
    generated,
    /target\\release\\nsis\\(?:x64|arm64)\\Plugins\\x86-unicode\\additional/
  )
  assert.match(generated, /\$FlintDesktopShortcutState = 1/)
  assert.match(generated, /Interactive installs always[\s\S]*completion page, which exclusively owns app launch/)
  assert.doesNotMatch(
    generated,
    /\$\{ElseIf\} \$FlintLaunchState = 1[\s\S]{0,120}Call RunMainBinary/
  )
  // The progress pages must advance on their own: the native Next button is
  // parked off-screen, so SetAutoClose false would strand the user on "Completed".
  assert.doesNotMatch(generated, /SetAutoClose false/)
  assert.equal(generated.match(/^\s*SetAutoClose true$/gm)?.length, 2)
})

test('template preparation preserves Windows ARM64 retargeting', async () => {
  const base = await readFile(basePath, 'utf8')
  const armCurrent = base
    .replace('!define ARCH "x64"', '!define ARCH "arm64"')
    .replaceAll('\\nsis\\x64\\', '\\nsis\\arm64\\')
    .replaceAll('x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc')
    .replaceAll('\\VC\\Runtimes\\x64', '\\VC\\Runtimes\\arm64')
    .replaceAll('VC_RuntimeMinimumVSU_amd64', 'VC_RuntimeMinimumVSU_arm64')

  const generated = transformWindowsInstallerTemplate(
    base,
    armCurrent,
    await localTemplateDefaults()
  )
  assert.match(generated, /!define ARCH "arm64"/)
  assert.match(generated, /\\nsis\\arm64\\/)
  assert.match(generated, /aarch64-pc-windows-msvc/)
  assert.match(generated, /\\VC\\Runtimes\\arm64/)
  assert.match(generated, /VC_RuntimeMinimumVSU_arm64/)
  assert.doesNotMatch(generated, /x86_64-pc-windows-msvc/)
  assert.match(
    generated,
    /!define ADDITIONALPLUGINSPATH "\{\{additional_plugins_path\}\}"/
  )
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
  assert.match(ui, /\$FlintLaunchState = 1[\s\S]*_FlintButton primary launch \d+ \$\{FLINT_FOOT_Y\} FlintFinishLaunch/)
  assert.match(ui, /_FlintButton primary finish \d+ \$\{FLINT_FOOT_Y\} FlintFinishClose/)
})

const wizardAssets = [
  'btn-uninstall.bmp',
  'btn-cancel.bmp',
  'switch-on.bmp',
  'switch-off.bmp',
  'field.bmp',
  'radio-on.bmp',
  'radio-off.bmp',
  ...['continue', 'install', 'launch', 'finish', 'close'].map((slug) => `btn-primary-${slug}.bmp`),
  ...['cancel', 'back', 'browse', 'close'].map((slug) => `btn-outline-${slug}.bmp`),
]

test('every bitmap used by the custom UI exists at every theme and DPI', async () => {
  const files = []
  for (const theme of ['light', 'dark']) {
    for (const scale of [100, 125, 150, 200]) {
      for (const asset of wizardAssets) {
        files.push(
          new URL(`../src-tauri/installer/windows/${theme}/${scale}/${asset}`, import.meta.url)
        )
      }
    }
  }
  await Promise.all(files.map((file) => access(file)))
  assert.equal(files.length, wizardAssets.length * 8)
})

test('reinstall version state survives the custom page helpers', async () => {
  const base = (await readFile(basePath, 'utf8')).replace(/\r\n/g, '\n')
  const ui = (await readInstallerUi()).replace(/\r\n/g, '\n')
  // The compare result lives in a dedicated Var, not in $R0.
  assert.match(ui, /^Var ReinstallVersionState$/m)
  assert.match(base, /Pop \$R0\n\s*StrCpy \$ReinstallVersionState \$R0/)
  const leave = base.slice(base.indexOf('Function PageLeaveReinstall'))
  const leaveBody = leave.slice(0, leave.indexOf('\nFunctionEnd'))
  assert.doesNotMatch(leaveBody, /\$R0/)
  assert.match(leaveBody, /\$ReinstallVersionState = 1/)
  const early = base.slice(base.indexOf('Section EarlyChecks'))
  assert.doesNotMatch(early.slice(0, early.indexOf('SectionEnd')), /\$R0/)
  // The shared page shell must preserve the registers the template pages use.
  const start = ui.indexOf('!macro _FlintFitPage')
  const fit = ui.slice(start, ui.indexOf('!macroend', start))
  assert.match(fit, /Push \$R0\n\s*Push \$R1/)
  assert.match(fit, /Pop \$R1\n\s*Pop \$R0/)
  // FlintMaintenance must not branch on $R0 after calling the shell.
  const maint = ui.slice(ui.indexOf('Function FlintMaintenance'))
  assert.doesNotMatch(maint.slice(0, maint.indexOf('\nFunctionEnd')), /\$R0/)
})

test('install location cannot be a drive root or a folder without an app directory', async () => {
  const ui = (await readInstallerUi()).replace(/\r\n/g, '\n')
  const browse = ui.slice(ui.indexOf('Function FlintBrowse'))
  assert.match(browse.slice(0, browse.indexOf('\nFunctionEnd')), /\\\$\{PRODUCTNAME\}/)
  const leave = ui.slice(ui.indexOf('Function FlintOptionsLeave'))
  const body = leave.slice(0, leave.indexOf('\nFunctionEnd'))
  assert.match(body, /drive root/)
  assert.match(body, /full install path/)
  assert.ok(body.indexOf('Abort') < body.indexOf('GetFullPathName $1 $0'))
  // GetFullPathName gives an empty string for a folder that does not exist
  // yet (a first install), so $INSTDIR must fall back to the validated path.
  assert.match(body, /\$\{OrIf\} \$1 == ""\s+StrCpy \$1 \$0/)
  assert.match(body, /StrCpy \$INSTDIR \$1/)
})

test('every Flint button is an nsDialogs bitmap, never a raw CreateWindowExW static', async () => {
  const ui = (await readInstallerUi()).replace(/\r\n/g, '\n')
  // A STATIC made with CreateWindowExW never reaches ${NSD_OnClick}: the
  // button would render and do nothing.
  assert.doesNotMatch(ui, /CreateWindowExW\(i 0, w "STATIC", w "\$\{label\}"/)
  assert.doesNotMatch(ui, /_FlintPrimaryButton|_FlintSecondaryButton/)
  const macro = ui.slice(ui.indexOf('!macro _FlintButton'))
  const body = macro.slice(0, macro.indexOf('!macroend'))
  assert.match(body, /NSD_CreateBitmap/)
  assert.match(body, /NSD_OnClick/)
})
