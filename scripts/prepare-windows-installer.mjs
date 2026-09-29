import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const basePath = join(repoRoot, 'src-tauri', 'tauri.bundle.windows.nsis.base.template')
const targetPath = join(repoRoot, 'src-tauri', 'tauri.bundle.windows.nsis.template')
const tauriConfigPath = join(repoRoot, 'src-tauri', 'tauri.conf.json')

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

function nsisBuildVersion(version) {
  const core = String(version ?? '').split('-', 1)[0]
  const parts = core.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length < 1 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`Cannot convert Tauri version "${version}" to an NSIS file version`)
  }
  return [...parts.slice(0, 4), 0, 0, 0, 0].slice(0, 4).join('.')
}

function preserveBuildSubstitutions(base, current, defaults = {}) {
  // Release workflows substitute these values before the regular build starts.
  // Prefer those values when present; a normal local build has the literal
  // jan_* placeholders, so fall back to the canonical Tauri config instead.
  const replacements = [
    ['jan_productname', 'PRODUCTNAME', defaults.productName],
    ['jan_version', 'VERSION', defaults.version],
    ['jan_build', 'VERSIONWITHBUILD', defaults.versionWithBuild],
    ['jan_mainbinaryname', 'MAINBINARYNAME', defaults.mainBinaryName],
    ['jan_bundleid', 'BUNDLEID', defaults.bundleId],
  ]
  let out = base
  for (const [placeholder, defineName, fallback] of replacements) {
    const currentValue = extractDefine(current, defineName)
    const value = currentValue && currentValue !== placeholder ? currentValue : fallback
    if (value) out = out.split(placeholder).join(String(value))
  }

  // The ARM64 workflow retargets the rendered NSIS template before Tauri runs.
  // beforeBuildCommand runs this generator afterwards, so preserve that target
  // rather than regenerating the x64 base over it.
  const arch = extractDefine(current, 'ARCH')
  if (arch === 'arm64') {
    out = out.replace('!define ARCH "x64"', '!define ARCH "arm64"')
    out = out.split('\\nsis\\x64\\').join('\\nsis\\arm64\\')
    out = out.split('x86_64-pc-windows-msvc').join('aarch64-pc-windows-msvc')
    out = out.split('\\VC\\Runtimes\\x64').join('\\VC\\Runtimes\\arm64')
    out = out.split('VC_RuntimeMinimumVSU_amd64').join('VC_RuntimeMinimumVSU_arm64')
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

export function transformWindowsInstallerTemplate(
  baseTemplate,
  currentTemplate = baseTemplate,
  defaults = {}
) {
  // Git may check the template out as CRLF on Windows. Keep the transformer
  // deterministic and make every guarded match independent of autocrlf.
  const base = baseTemplate.replace(/\r\n/g, '\n')
  const current = currentTemplate.replace(/\r\n/g, '\n')
  let out = preserveBuildSubstitutions(base, current, defaults)

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
  const [base, current, configRaw] = await Promise.all([
    readFile(basePath, 'utf8'),
    readFile(targetPath, 'utf8'),
    readFile(tauriConfigPath, 'utf8'),
  ])
  const config = JSON.parse(configRaw)
  const defaults = {
    productName: config.productName,
    version: config.version,
    versionWithBuild: nsisBuildVersion(config.version),
    mainBinaryName: config.mainBinaryName ?? config.productName,
    bundleId: config.identifier,
  }
  const generated = transformWindowsInstallerTemplate(base, current, defaults)
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
