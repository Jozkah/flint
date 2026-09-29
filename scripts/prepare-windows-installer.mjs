import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const basePath = join(repoRoot, 'src-tauri', 'tauri.bundle.windows.nsis.base.template')
const targetPath = join(repoRoot, 'src-tauri', 'tauri.bundle.windows.nsis.template')

function replaceOnce(source, search, replacement, label) {
  const index = source.search(search)
  if (index < 0) throw new Error(`Windows installer template drift: missing ${label}`)
  const matched = source.match(search)
  if (!matched) throw new Error(`Windows installer template drift: missing ${label}`)
  const after = source.slice(index + matched[0].length)
  if (after.search(search) >= 0) {
    throw new Error(`Windows installer template drift: ${label} matched more than once`)
  }
  return source.slice(0, index) + replacement + after
}

function extractDefine(template, name) {
  const m = template.match(new RegExp(`^!define ${name} "([^"]*)"$`, 'm'))
  return m?.[1] ?? null
}

function preserveBuildSubstitutions(base, current) {
  // Release workflows substitute these values before the regular build starts.
  // Read them back before regenerating so the custom-page transform never
  // discards a release version, product name, binary name or workspace path.
  const replacements = [
    ['jan_productname', extractDefine(current, 'PRODUCTNAME')],
    ['jan_version', extractDefine(current, 'VERSION')],
    ['jan_build', extractDefine(current, 'VERSIONWITHBUILD')],
    ['jan_mainbinaryname', extractDefine(current, 'MAINBINARYNAME')],
    ['jan_bundleid', extractDefine(current, 'BUNDLEID')],
  ]
  let out = base
  for (const [placeholder, value] of replacements) {
    if (value && value !== placeholder) out = out.split(placeholder).join(value)
  }

  // Release CI may already have replaced this placeholder. For ordinary local
  // builds it has not, so materialize the real checkout root here. This is why
  // the custom template can now live permanently in tauri.windows.conf.json.
  const currentWorkspace = extractDefine(current, 'FLINT_WORKSPACE')
  const workspace =
    currentWorkspace && currentWorkspace !== 'flint_workspace'
      ? currentWorkspace
      : repoRoot
  out = out.split('flint_workspace').join(workspace)
  return out
}

export function transformWindowsInstallerTemplate(baseTemplate, currentTemplate = baseTemplate) {
  // Git may check the template out as CRLF on Windows. Keep the transformer
  // deterministic and make every guarded match independent of autocrlf.
  const base = baseTemplate.replace(/\r\n/g, '\n')
  const current = currentTemplate.replace(/\r\n/g, '\n')
  let out = preserveBuildSubstitutions(base, current)

  out = replaceOnce(
    out,
    /; 1\. Welcome Page\n!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive\n!insertmacro MUI_PAGE_WELCOME/,
    '; 1. Flint welcome page\n!insertmacro FLINT_WELCOME_PAGE',
    'welcome page'
  )

  out = replaceOnce(
    out,
    /Var ReinstallPageCheck\nPage custom PageReinstall PageLeaveReinstall/,
    'Page custom PageReinstall PageLeaveReinstall',
    'duplicate maintenance variable'
  )

  out = replaceOnce(
    out,
    /  \$\{If\} \$PassiveMode = 1\n    Call PageLeaveReinstall\n  \$\{Else\}\n[\s\S]*?    nsDialogs::Show\n  \$\{EndIf\}\nFunctionEnd\nFunction PageReinstallUpdateSelection/,
    `  \${If} $PassiveMode = 1\n    Call PageLeaveReinstall\n  \${Else}\n    Call FlintMaintenance\n  \${EndIf}\nFunctionEnd\nFunction PageReinstallUpdateSelection`,
    'maintenance page body'
  )

  out = replaceOnce(
    out,
    /; 5\. Choose install directory page\n!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive\n!insertmacro MUI_PAGE_DIRECTORY/,
    '; 5. Flint installation options\n!insertmacro FLINT_OPTIONS_PAGE',
    'directory page'
  )

  out = replaceOnce(
    out,
    /; 8\. Finish page\n;[\s\S]*?!insertmacro MUI_PAGE_FINISH/,
    '; 8. Flint finish page\n!insertmacro FLINT_FINISH_PAGE',
    'finish page'
  )

  out = replaceOnce(
    out,
    /!insertmacro MUI_UNPAGE_INSTFILES\n\n!insertmacro FLINT_UI_FUNCTIONS ""/,
    '!insertmacro MUI_UNPAGE_INSTFILES\n\n; 3. Uninstall complete page\n!insertmacro FLINT_UNINSTALL_FINISH_PAGE\n\n!insertmacro FLINT_UI_FUNCTIONS ""',
    'uninstaller finish page'
  )

  out = replaceOnce(
    out,
    /  ; always run in passive mode\.[^\n]*\n  ; only styles the progress page, so the wizard pages must stay skipped\.\n  StrCpy \$PassiveMode 1\n/,
    '',
    'forced passive mode'
  )

  out = replaceOnce(
    out,
    /  ; Create desktop shortcut for silent and passive installers\n  ; because finish page will be skipped\n  \$\{If\} \$PassiveMode = 1\n  \$\{OrIf} \$\{Silent\}\n    Call CreateOrUpdateDesktopShortcut\n  \$\{EndIf\}/,
    `  ; Passive/silent installs keep their existing shortcut behaviour. The\n  ; interactive installer follows the switch on Flint's options page.\n  \${If} $PassiveMode = 1\n  \${OrIf} \${Silent}\n    Call CreateOrUpdateDesktopShortcut\n  \${ElseIf} $FlintDesktopShortcutState = 1\n    Call CreateOrUpdateDesktopShortcut\n  \${EndIf}`,
    'desktop shortcut behaviour'
  )

  out = replaceOnce(
    out,
    /  ; Auto close this page for passive mode\n  \$\{If\} \$PassiveMode = 1\n    SetAutoClose true\n  \$\{EndIf\}\nSectionEnd/,
    `  ; Passive installs have no completion page. Interactive installs always\n  ; continue to Flint's completion page, which exclusively owns app launch.\n  \${If} $PassiveMode = 1\n    SetAutoClose true\n  \${EndIf}\nSectionEnd`,
    'interactive completion behaviour'
  )

  out = replaceOnce(
    out,
    /  ; Always auto close: the Flint progress page has no details or Close button\n  ; to linger on \(a failed uninstall brings the native buttons back instead\)\.\n  SetAutoClose true/,
    `  ; Interactive uninstalls continue to Flint's completion page.\n  \${If} $PassiveMode = 1\n  \${OrIf} \${Silent}\n    SetAutoClose true\n  \${Else}\n    SetAutoClose false\n  \${EndIf}`,
    'uninstaller autoclose'
  )

  return out
}

export async function prepareWindowsInstaller({ check = false } = {}) {
  const [base, current] = await Promise.all([
    readFile(basePath, 'utf8'),
    readFile(targetPath, 'utf8'),
  ])
  const generated = transformWindowsInstallerTemplate(base, current)
  if (check) return generated
  if (generated !== current) await writeFile(targetPath, generated)
  return generated
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  prepareWindowsInstaller().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
