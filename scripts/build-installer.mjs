/**
 * Builds the Flint installers from a fresh clone with one command:
 *
 *     node scripts/build-installer.mjs
 *
 * It checks the toolchain first and says exactly what is missing and how to
 * install it, then installs dependencies, builds the llama.cpp engine and the
 * app, and prints where the installers are.
 *
 * It exists because the manual sequence had too many ways to go wrong on
 * Windows: `make` only works from Git Bash (PowerShell's `bash` is WSL),
 * `corepack enable` needs an Administrator shell, and the LLVM installer does
 * not put clang on PATH. None of those apply here: Windows needs no make at
 * all, yarn runs through `corepack yarn`, Git's own bash is located by path
 * and LLVM is picked up from its default install folder.
 *
 * Usage: node scripts/build-installer.mjs [engine-variant]
 *   engine-variant: cpu (default; metal on macOS), vulkan, cuda12, cuda13,
 *   hip/rocm, joined with `-`. Also read from JAN_ENGINE_VARIANT.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statfsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const variant =
  process.argv[2] || process.env.JAN_ENGINE_VARIANT || (isMac ? 'metal' : 'cpu')

function findOnPath(name) {
  const exts = isWindows ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function prependPath(dir) {
  process.env.PATH = dir + path.delimiter + (process.env.PATH || '')
}

function capture(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function fail(lines) {
  console.error('\n' + [].concat(lines).join('\n') + '\n')
  process.exit(1)
}

function run(title, cmd, args, options = {}) {
  console.log(`\n=== ${title}`)
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...options })
  if (result.error) fail(`Could not start "${cmd}": ${result.error.message}`)
  if (result.status !== 0) {
    fail([
      `"${title}" failed (exit code ${result.status}).`,
      'The error is in the output above. docs/BUILDING.md has a Troubleshooting section.',
    ])
  }
}

/**
 * Git for Windows' bash, by path. `bash` on PATH is not good enough: in
 * PowerShell and cmd it is usually C:\Windows\System32\bash.exe, which is WSL.
 */
function findGitBash() {
  const candidates = []
  const execPath = capture('git', ['--exec-path'])
  if (execPath) {
    // <Git>/mingw64/libexec/git-core
    candidates.push(path.resolve(execPath, '..', '..', '..', 'bin', 'bash.exe'))
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'))
  }
  return candidates.find((c) => existsSync(c)) ?? null
}

function hasMsvcBuildTools() {
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe'
  )
  if (!existsSync(vswhere)) return false
  const found = capture(vswhere, [
    '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath',
  ])
  return Boolean(found)
}

// ---------------------------------------------------------------------------
// 1. Toolchain check. Everything is checked before anything is built, so a
//    missing tool costs seconds, not the half hour before the step that needs it.
// ---------------------------------------------------------------------------
const missing = []
const need = (ok, what, how) => {
  if (!ok) missing.push(`  - ${what}\n      ${how}`)
}

const nodeMajor = Number(process.versions.node.split('.')[0])
need(nodeMajor >= 20, `Node.js 20 or newer (this is ${process.versions.node})`,
  isWindows ? 'winget install -e --id OpenJS.NodeJS.LTS' : 'install Node 20+ from https://nodejs.org')

need(findOnPath('git'), 'Git',
  isWindows ? 'winget install -e --id Git.Git' : 'install git with your package manager')

const hasCargo = findOnPath('cargo') && findOnPath('rustc')
need(hasCargo, 'Rust (cargo and rustc)',
  isWindows ? 'winget install -e --id Rustlang.Rustup   then: rustup default stable-msvc' : 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh')

need(findOnPath('cmake'), 'CMake',
  isWindows ? 'winget install -e --id Kitware.CMake' : isMac ? 'brew install cmake' : 'sudo apt install -y cmake')

let gitBash = null
if (isWindows) {
  if (hasCargo) {
    const host = (capture('rustc', ['-vV']) || '').split('\n').find((l) => l.startsWith('host:')) || ''
    need(host.includes('msvc'), `Rust on the MSVC toolchain (it is on "${host.replace('host:', '').trim()}")`,
      'rustup default stable-msvc')
  }
  need(hasMsvcBuildTools(), 'Visual Studio Build Tools with the C++ workload',
    'winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"')

  need(findOnPath('ninja'), 'Ninja', 'winget install -e --id Ninja-build.Ninja')

  // The LLVM installer does not add itself to PATH, so look where it installs.
  if (!findOnPath('clang')) {
    const llvmBin = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LLVM', 'bin')
    if (existsSync(path.join(llvmBin, 'clang.exe'))) prependPath(llvmBin)
  }
  need(findOnPath('clang'), 'LLVM (clang)', 'winget install -e --id LLVM.LLVM')

  gitBash = findGitBash()
  need(gitBash, 'Git Bash (part of Git for Windows)', 'winget install -e --id Git.Git')
} else {
  need(findOnPath('make'), 'make',
    isMac ? 'xcode-select --install' : 'sudo apt install -y build-essential')
  need(findOnPath('ninja'), 'Ninja', isMac ? 'brew install ninja' : 'sudo apt install -y ninja-build')
}

const hasCorepack = Boolean(findOnPath('corepack'))
need(hasCorepack || findOnPath('yarn'), 'Corepack (ships with Node 20 to 24)', 'npm install -g corepack')

if (missing.length) {
  fail([
    'Flint cannot be built yet. Missing:',
    '',
    ...missing,
    '',
    'Install what is listed, open a NEW terminal so PATH is refreshed, and run this script again.',
    'docs/BUILDING.md step 1 has the full per-OS list.',
  ])
}

try {
  const stats = statfsSync(root)
  const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3
  if (freeGb < 20) {
    console.warn(`\nWarning: only ${freeGb.toFixed(0)} GB free on this drive; a first build can need 15 to 30 GB.`)
  }
} catch {
  // statfs is best effort; an unusual filesystem should not stop the build.
}

console.log(`Toolchain OK. Building Flint with the "${variant}" engine. A first build takes 20 to 60 minutes.`)

// `corepack yarn` runs the yarn version package.json pins without needing
// `corepack enable`, which fails without Administrator rights on Windows.
// One command string with `shell: true`, because corepack and yarn are .cmd
// shims on Windows; an argument list there prints Node's DEP0190 deprecation.
const yarnPrefix = hasCorepack ? 'corepack yarn' : 'yarn'
const yarn = (title, script) => run(title, `${yarnPrefix} ${script}`, [], { shell: true })

// ---------------------------------------------------------------------------
// 2. Build.
// ---------------------------------------------------------------------------
if (isWindows) {
  yarn('Install dependencies (yarn install)', 'install')

  // The Windows half of the Makefile's `build-engine`, without make: the same
  // scripts and the same cargo invocation, run through Git's bash by path.
  // Keep the token table in step with ENGINE_FEATURE_* in the Makefile.
  const featureOf = {
    cpu: 'engine',
    vulkan: 'engine-vulkan',
    cuda12: 'engine-cuda',
    cuda13: 'engine-cuda',
    hip: 'engine-hip',
    rocm: 'engine-hip',
  }
  const tokens = variant.split('-')
  const unknown = tokens.filter((t) => !featureOf[t])
  if (unknown.length) {
    fail(`Unknown engine variant "${variant}": no backend named "${unknown.join(', ')}". Use cpu, vulkan, cuda12, cuda13, hip or rocm, joined by "-".`)
  }
  const features = new Set(tokens.map((t) => featureOf[t]))
  // A vendor runtime ships with Vulkan as its fallback, as in the Makefile.
  if ((features.has('engine-cuda') || features.has('engine-hip')) && process.env.JAN_ENGINE_VULKAN_FALLBACK !== '0') {
    features.add('engine-vulkan')
  }
  const featureList = [...features].sort().join(',')

  const pluginDir = path.join('src-tauri', 'plugins', 'tauri-plugin-llamacpp')
  const engineEnv = {
    ...process.env,
    JAN_ENGINE_BUILD_LOG: path.join(root, 'src-tauri', 'target', 'engine-build.log'),
    CARGO_MAKEFLAGS: '',
  }
  const bash = (title, args) => run(title, gitBash, args, { env: engineEnv })

  bash('Fetch the llama.cpp source', ['src-tauri/build-utils/fetch-engine-source.sh'])
  bash('Check the engine toolchain', ['src-tauri/build-utils/check-engine-toolchain.sh', variant, featureList])
  mkdirSync(path.join('src-tauri', 'resources', 'bin'), { recursive: true })
  mkdirSync(path.join('src-tauri', 'target'), { recursive: true })
  run('Build the llama.cpp engine', 'cargo',
    ['build', '--release', '--features', featureList, '--bin', 'flint-llama-worker'],
    { cwd: pluginDir, env: engineEnv })
  bash('Stage the engine', ['src-tauri/build-utils/stage-engine.sh', 'release'])
  bash('Sign the engine (skipped without a certificate)', ['src-tauri/build-utils/sign-engine.sh'])

  yarn('Build the app and installers (yarn build)', 'build')
} else {
  // `make build` is what the release workflow runs on macOS and Linux. It calls
  // plain `yarn`, so that has to be on PATH.
  if (!findOnPath('yarn')) {
    run('Enable Yarn (corepack enable)', 'corepack', ['enable'])
    if (!findOnPath('yarn')) {
      fail('`corepack enable` did not put yarn on PATH. Run `sudo corepack enable`, then run this script again.')
    }
  }
  run('Build Flint (make build)', 'make', ['build', `JAN_ENGINE_VARIANT=${variant}`])
}

// ---------------------------------------------------------------------------
// 3. Report where the installers are.
// ---------------------------------------------------------------------------
const wanted = ['-setup.exe', '.msi', '.dmg', '.deb', '.AppImage']
const targetDir = path.join(root, 'src-tauri', 'target')
// target/release/bundle, or target/<triple>/release/bundle for a macOS build.
const bundleDirs = [path.join(targetDir, 'release', 'bundle')]
if (existsSync(targetDir)) {
  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (entry.isDirectory()) bundleDirs.push(path.join(targetDir, entry.name, 'release', 'bundle'))
  }
}
const installers = []
for (const bundleDir of bundleDirs) {
  if (!existsSync(bundleDir)) continue
  for (const kind of readdirSync(bundleDir, { withFileTypes: true })) {
    if (!kind.isDirectory()) continue
    for (const file of readdirSync(path.join(bundleDir, kind.name))) {
      if (wanted.some((ext) => file.endsWith(ext))) installers.push(path.join(bundleDir, kind.name, file))
    }
  }
}

if (!installers.length) {
  fail('The build finished but no installer was found under src-tauri/target. Please report this with the output above.')
}
console.log('\nDone. Installers:')
for (const file of installers) console.log(`  ${file}`)
