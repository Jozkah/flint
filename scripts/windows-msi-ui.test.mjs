import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

// Static checks for the custom MSI wizard. Building the MSI needs the WiX
// toolset that Tauri downloads, so these cover what can go wrong without it:
// the wiring, every referenced file, and the rules Windows Installer enforces
// when Tauri runs `light` with ICE validation.
const root = new URL('../src-tauri/', import.meta.url)
const read = async (path) => (await readFile(new URL(path, root), 'utf8')).replace(/\r\n/g, '\n')

test('the Windows bundle uses the Flint wizard through a template and a fragment', async () => {
  const conf = JSON.parse(await read('tauri.windows.conf.json'))
  const wix = conf.bundle.windows.wix
  assert.equal(wix.template, './installer/wix/main.wxs')
  assert.deepEqual(wix.fragmentPaths, ['./installer/wix/flint-ui.wxs'])
  await access(new URL('installer/wix/main.wxs', root))
  await access(new URL('installer/wix/flint-ui.wxs', root))
})

test('main.wxs only swaps the wizard and keeps Tauri placeholders intact', async () => {
  const main = await read('installer/wix/main.wxs')
  assert.match(main, /<UIRef Id="WixUI_Flint" \/>/)
  assert.doesNotMatch(main, /WixUI_InstallDir|WIXUI_EXITDIALOGOPTIONALCHECKBOX/)
  // The action the final page launches the app with.
  assert.match(main, /<CustomAction Id="LaunchApplication"[^>]*FileKey="Path"/)
  // Tauri fills these in; losing one breaks the package.
  for (const placeholder of ['{{product_name}}', '{{upgrade_code}}', '{{version}}', '{{main_binary_path}}', '{{resources}}']) {
    assert.ok(main.includes(placeholder), `missing ${placeholder}`)
  }
  // Handlebars would try to render a placeholder-looking comment before the preamble.
  const preamble = main.slice(0, main.indexOf('<?if'))
  assert.ok(!preamble.includes('{{'), 'no {{ }} before the first preprocessor line')
})

test('every binary the dialogs use exists and every dialog control refers to a declared binary', async () => {
  const binaries = await read('installer/wix/flint-ui-binaries.wxi')
  const dialogs = await read('installer/wix/flint-ui-dialogs.wxi')
  const declared = new Map()
  for (const m of binaries.matchAll(/<Binary Id="([^"]+)" SourceFile="\$\(sys\.SOURCEFILEDIR\)([^"]+)"/g)) {
    declared.set(m[1], m[2].replace(/\\/g, '/'))
  }
  assert.ok(declared.size > 20, 'expected the page, button and strip bitmaps')
  for (const [id, file] of declared) {
    await access(new URL(`installer/wix/${file}`, root)).catch(() => assert.fail(`${id}: ${file} is missing`))
  }
  for (const m of dialogs.matchAll(/Type="(?:Bitmap|PushButton)"[^>]*Text="([A-Za-z_]+)"/g)) {
    assert.ok(declared.has(m[1]), `${m[1]} is not a declared Binary`)
  }
})

test('the standard dialogs and sequences that ICE20 requires are all present', async () => {
  const ui = await read('installer/wix/flint-ui.wxs')
  const dialogs = await read('installer/wix/flint-ui-dialogs.wxi')
  assert.match(dialogs, /<Dialog Id="FilesInUse"[^>]*KeepModeless="yes"/)
  assert.match(dialogs, /Type="ListBox"[^>]*Property="FileInUseProcess"/)
  for (const id of ['Exit', 'Ignore', 'Retry']) {
    assert.match(dialogs, new RegExp(`<Control Id="${id}" Type="PushButton"`), `FilesInUse needs a real ${id} push button`)
  }
  // The error dialog: flagged, ErrorText first, and every button Windows Installer can show.
  const error = ui.slice(ui.indexOf('<Dialog Id="FlintErrorDlg"'), ui.indexOf('</Dialog>', ui.indexOf('<Dialog Id="FlintErrorDlg"')))
  assert.match(error, /ErrorDialog="yes"/)
  assert.ok(error.indexOf('Id="ErrorText"') < error.indexOf('<Control Id="Y"'), 'ErrorText must be the first control')
  for (const id of ['A', 'C', 'I', 'N', 'O', 'R', 'Y']) assert.match(error, new RegExp(`<Control Id="${id}" Type="PushButton"`))
  assert.match(ui, /<Property Id="ErrorDialog" Value="FlintErrorDlg" \/>/)
  // The fatal, cancel and success exits exist in both UI sequences.
  for (const [seq, count] of [['InstallUISequence', 3], ['AdminUISequence', 3]]) {
    const block = ui.slice(ui.indexOf(`<${seq}>`), ui.indexOf(`</${seq}>`))
    for (const exit of ['error', 'cancel', 'success']) assert.match(block, new RegExp(`OnExit="${exit}"`), `${seq} OnExit=${exit}`)
    assert.ok((block.match(/OnExit=/g) ?? []).length >= count)
  }
})

test('Browse opens the Windows folder picker and keeps the install in its own subfolder', async () => {
  const dialogs = await read('installer/wix/flint-ui-dialogs.wxi')
  const install = dialogs.slice(dialogs.indexOf('<Dialog Id="FlintInstallDirDlg"'), dialogs.indexOf('</Dialog>', dialogs.indexOf('<Dialog Id="FlintInstallDirDlg"')))
  assert.match(install, /<Publish Event="DoAction" Value="FlintBrowseFolder"/)
  // Windows Installer's own folder list cannot be styled, so there is no dialog for it.
  assert.doesNotMatch(dialogs, /DirectoryList|FlintBrowseDlg/)
  const ui = await read('installer/wix/flint-ui.wxs')
  assert.match(ui, /<CustomAction Id="FlintBrowseFolder" BinaryKey="FlintBrowseScript" JScriptCall="FlintBrowse"/)
  assert.match(ui, /<Binary Id="FlintBrowseScript" SourceFile="\$\(sys\.SOURCEFILEDIR\)flint-browse\.js"/)
  const script = await read('installer/wix/flint-browse.js')
  assert.match(script, /BrowseForFolder\(/)
  // A bare folder or drive root must never become the install directory: it gets its own subfolder.
  assert.match(script, /path \+ "\\\\" \+ name \+ "\\\\"/)
  assert.match(script, /path\.length > 2/)
})

test('WiX does not see duplicate ids and ICE17 finds no button without an event', async () => {
  const dialogs = await read('installer/wix/flint-ui-dialogs.wxi')
  for (const dialog of dialogs.matchAll(/<Dialog Id="([^"]+)"[\s\S]*?<\/Dialog>/g)) {
    const ids = [...dialog[0].matchAll(/<Control Id="([^"]+)"/g)].map((m) => m[1])
    assert.equal(new Set(ids).size, ids.length, `${dialog[1]} repeats a control id`)
    for (const button of dialog[0].matchAll(/<Control Id="([^"]+)" Type="PushButton"[\s\S]*?<\/Control>/g)) {
      assert.match(button[0], /<Publish /, `${dialog[1]}/${button[1]} is a do-nothing button (ICE17)`)
    }
  }
  // The dialogs may not reuse ids of dialogs the WixUI extension defines, or light stops on a duplicate symbol.
  for (const reserved of ['FatalError', 'UserExit', 'ExitDialog', 'ErrorDlg', 'CancelDlg', 'ProgressDlg', 'WelcomeDlg', 'InstallDirDlg']) {
    assert.doesNotMatch(dialogs, new RegExp(`<Dialog Id="${reserved}"`), `${reserved} clashes with WixUIExtension`)
  }
})

test('every button sits on whole dialog units and its strips cover the native frame', async () => {
  const dialogs = await read('installer/wix/flint-ui-dialogs.wxi')
  for (const dialog of dialogs.matchAll(/<Dialog Id="([^"]+)"[\s\S]*?<\/Dialog>/g)) {
    const buttons = [...dialog[0].matchAll(/<Control Id="([A-Za-z]+)" Type="PushButton" X="(\d+)" Y="(\d+)" Width="(\d+)" Height="(\d+)" Bitmap="yes"/g)]
    for (const [, id, x, y, w, h] of buttons) {
      const strips = [...dialog[0].matchAll(new RegExp(`<Control Id="${id}_([tblr])" Type="Bitmap"`, 'g'))].map((m) => m[1]).sort().join('')
      assert.equal(strips, 'blrt', `${dialog[1]}/${id} needs four page-coloured strips over Windows' button frame`)
      assert.ok(Number(w) >= 30 && [30, 33].includes(Number(h)), `${dialog[1]}/${id} is ${w}x${h} DU`)
      assert.ok(Number.isInteger(Number(x)) && Number.isInteger(Number(y)))
    }
  }
})

test('the MSI is light only, for the reason written down', async () => {
  const readme = await read('installer/README.md')
  assert.match(readme, /The MSI is light only/)
  const ui = await read('installer/wix/flint-ui.wxs')
  assert.doesNotMatch(ui, /AppsUseLightTheme|FLINT_HIDE_/)
})
