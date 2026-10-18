/**
 * Which Tauri commands the app can ask for that `flint serve` has no route for.
 *   node scripts/web-command-inventory.ts           (print the report)
 *   node scripts/web-command-inventory.ts --write (refresh the fixture)
 *
 * Commands: first string argument of invoke/call/rpc/hostInvoke/this.invoke,
 * plus every `plugin:<name>|<command>` literal, across the web app, the
 * bundled extensions and the plugin guest APIs. Routes: the string patterns in
 * each web_server module's `handles` and in `rpc_route`'s own match.
 * The difference must be listed in DESKTOP_ONLY_COMMANDS (tauriBridgeShim.ts),
 * which the browser refuses without a request; the test keeps both in step.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(here, '..', '..')
export const FIXTURE = path.join(here, '..', 'src', 'lib', '__tests__', 'fixtures', 'unrouted-commands.json')

const PLUGINS = path.join(REPO, 'src-tauri', 'plugins')
const SOURCE_ROOTS = [
  'web-app/src',
  'extensions',
  'core/src',
  ...fs
    .readdirSync(PLUGINS)
    .filter((p) => p.startsWith('tauri-plugin-'))
    .map((p) => `src-tauri/plugins/${p}/guest-js`),
]
const SKIP_DIR = new Set(['node_modules', 'dist', 'dist-js', '__tests__', '__mocks__', 'test', 'dev'])
// The allowlist names every command; it is the answer, not a caller.
const NOT_CALLERS = new Set(['desktopOnlyCommands.ts'])
const isSource = (f: string) =>
  !NOT_CALLERS.has(f) && /\.(ts|tsx)$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f) && !f.endsWith('.d.ts')

function walk(dir: string, out: string[]) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) walk(full, out)
    } else if (isSource(entry.name)) out.push(full)
  }
}

const CALL = /\b(?:invoke|call|rpc|hostInvoke|this\.invoke)(?:<(?:[^<>()]|<[^<>()]*>)*>)?\(\s*['"`]([A-Za-z][\w:|-]*)['"`]/g
const PLUGIN = /['"`](plugin:[a-z][\w-]*\|[a-z][\w]*)['"`]/g

/** The exported function a match sits in, if any (the wrapper pages import). */
function enclosingExport(text: string, at: number): string | null {
  const before = text.slice(0, at)
  const all = [...before.matchAll(/^export (?:async )?function (\w+)|^export const (\w+) =/gm)]
  const last = all.at(-1)
  return last ? (last[1] ?? last[2]) : null
}

/** The module specifiers that reach a source file: its package or its basename. */
function specifiersFor(rel: string): (spec: string) => boolean {
  const plugin = rel.match(/^src-tauri\/plugins\/([^/]+)\/guest-js\//)
  if (plugin) {
    const name = JSON.parse(fs.readFileSync(path.join(PLUGINS, plugin[1], 'package.json'), 'utf8')).name
    return (spec) => spec === name || spec.includes(`${plugin[1]}/guest-js`)
  }
  const base = path.basename(rel).replace(/\.tsx?$/, '')
  return (spec) => spec.split('/').at(-1) === base
}

/**
 * command -> files that name it, plus (one level up) the files that import the
 * exported wrapper it sits in, shown as `file (via wrapper)`: those are the
 * surfaces that ask for it.
 */
export function webCommands(): Map<string, Set<string>> {
  const files: string[] = []
  for (const root of SOURCE_ROOTS) walk(path.join(REPO, root), files)
  const texts = new Map(files.map((f) => [path.relative(REPO, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')]))
  const found = new Map<string, Set<string>>()
  const wrappers: { command: string; file: string; fn: string }[] = []
  for (const [rel, text] of texts) {
    for (const re of [CALL, PLUGIN]) {
      for (const m of text.matchAll(re)) {
        const name = m[1]
        // Only command-shaped names: snake_case or plugin:x|y.
        if (!/^(plugin:[\w-]+\|\w+|[a-z][a-z0-9]*(_[a-z0-9]+)+)$/.test(name)) continue
        if (!found.has(name)) found.set(name, new Set())
        found.get(name)!.add(rel)
        const fn = enclosingExport(text, m.index ?? 0)
        if (fn) wrappers.push({ command: name, file: rel, fn })
      }
    }
  }
  for (const { command, file, fn } of wrappers) {
    const reaches = specifiersFor(file)
    const imports = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`)
    for (const [rel, text] of texts) {
      const m = rel !== file ? text.match(imports) : null
      if (m && reaches(m[1])) found.get(command)!.add(`${rel} (via ${fn})`)
    }
  }
  return found
}

const WEB_SERVER = path.join(REPO, 'src-tauri', 'src', 'core', 'web_server')

/** Body of `fn <name>` up to the closing brace at column 0. */
function fnBody(text: string, name: string): string {
  const start = text.search(new RegExp(`fn ${name}\\b`))
  if (start < 0) return ''
  const end = text.indexOf('\n}', start)
  return text.slice(start, end < 0 ? undefined : end)
}

export function serverRoutes(): Set<string> {
  const routes = new Set<string>()
  const literals = (s: string) => [...s.matchAll(/"([^"\\]+)"/g)].map((m) => m[1])
  for (const f of fs.readdirSync(WEB_SERVER).filter((f) => f.endsWith('.rs'))) {
    const text = fs.readFileSync(path.join(WEB_SERVER, f), 'utf8')
    // `handles` and the local predicates it ORs in (`|| is_task_command(command)`).
    const handles = fnBody(text, 'handles')
    const helpers = [...handles.matchAll(/\|\|\s*(\w+)\(command\)/g)].map((m) => m[1])
    for (const body of [handles, ...helpers.map((fn) => fnBody(text, fn))]) {
      for (const l of literals(body)) routes.add(l)
    }
    // Command tables a `handles` consults (`TASK_COMMANDS.contains(..)`).
    for (const m of text.matchAll(/const [A-Z_]*COMMANDS[^=]*=\s*&?\[([^\]]*)\]/g)) {
      for (const l of literals(m[1])) routes.add(l)
    }
  }
  // rpc_route's own arms: lines that open with a string pattern.
  const body = fnBody(fs.readFileSync(path.join(WEB_SERVER, 'server.rs'), 'utf8'), 'rpc_route')
  for (const line of body.split('\n')) {
    const arm = line.match(/^\s*((?:\|\s*)?"[^"]+"(?:\s*\|\s*"[^"]+")*)\s*(?:=>|\|\s*$)/)
    if (arm) for (const l of literals(arm[1])) routes.add(l)
  }
  return routes
}

export type Unrouted = Record<string, string[]>

export function unroutedCommands(): Unrouted {
  const routes = serverRoutes()
  const out: Unrouted = {}
  for (const [name, files] of [...webCommands()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!routes.has(name)) out[name] = [...files].sort()
  }
  return out
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const unrouted = unroutedCommands()
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true })
    fs.writeFileSync(FIXTURE, JSON.stringify(unrouted, null, 2) + '\n')
  }
  for (const [name, files] of Object.entries(unrouted)) console.log(`${name}\n  ${files.join('\n  ')}`)
  console.log(`\n${Object.keys(unrouted).length} unrouted of ${webCommands().size} commands; ${serverRoutes().size} routes`)
}
