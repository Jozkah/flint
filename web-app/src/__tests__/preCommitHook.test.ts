/**
 * The pre-commit gate.
 *
 * It was one line of shell with no shebang and no executable bit, which Git on
 * Windows cannot start:
 *
 *     error: cannot spawn .husky/pre-commit: Exec format error
 *
 * So every commit on this platform either failed or was made with
 * `--no-verify`, and a repository with a gate nobody can run has no gate. The
 * checks now live in a Node script, which is what makes them testable at all --
 * this file could not have been written against the old hook.
 *
 * The script is exercised in a real Node process rather than imported into the
 * test runner. That is not a workaround: the hook runs under whatever `node`
 * Git finds, so testing it under Vite's transform pipeline would be testing a
 * different program from the one that gates commits.
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.cwd(), '..')
const scriptPath = resolve(root, 'scripts', 'pre-commit.mjs')
const hook = () => readFileSync(resolve(root, '.husky', 'pre-commit'), 'utf8')

type Call = { command: string; args: string[]; cwd: string; shell?: boolean }
type Outcome = { status: number; calls: Call[]; logs: string[] }

/**
 * Run `runChecks` in a real Node process with `run` and `exists` stubbed, and
 * report what it did.
 *
 * `statuses` maps a command name to the exit status the stub should report, so
 * a test can fail `git` or `yarn` without needing either.
 */
function check(options: {
  statuses?: Record<string, number>
  installed?: boolean
  platform?: string
  root?: string
}): Outcome {
  const config = JSON.stringify({
    statuses: options.statuses ?? {},
    installed: options.installed ?? true,
    platform: options.platform ?? process.platform,
    root: options.root ?? '/repo',
  })
  const program = `
    import { runChecks } from ${JSON.stringify(pathToFileURL(scriptPath).href)}
    const config = ${config}
    const calls = []
    const logs = []
    const status = runChecks({
      root: config.root,
      platform: config.platform,
      exists: () => config.installed,
      log: (message) => logs.push(message),
      run: (command, args, cwd, useShell) => {
        calls.push({ command, args, cwd, shell: useShell })
        const code = config.statuses[command] ?? 0
        return { ok: code === 0, status: code }
      },
    })
    process.stdout.write(JSON.stringify({ status, calls, logs }))
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8',
  })
  return JSON.parse(out) as Outcome
}

describe('the pre-commit hook entry point', () => {
  it('has a shebang, which is what Git for Windows could not do without', () => {
    expect(hook().startsWith('#!')).toBe(true)
    expect(hook().split('\n')[0]).toBe('#!/usr/bin/env sh')
  })

  it('ends with a newline, so the last line is a line', () => {
    expect(hook().endsWith('\n')).toBe(true)
  })

  it('delegates rather than deciding anything itself', () => {
    // The point of the split: shell that only finds Node, and checks that can
    // be tested. A hook that grew its own logic would drift back to untestable.
    expect(hook()).toContain('exec node')
    expect(hook()).toContain('./scripts/pre-commit.mjs')
    // `exec` is what makes the script's exit status the hook's.
    expect(hook()).toMatch(/exec node .*"\$@"/)
  })

  it('uses no Bash-only syntax', () => {
    // Git for Windows runs hooks with `sh`, where `[[`, `function name()` and
    // arithmetic expansion are all syntax errors.
    const body = hook()
    expect(body).not.toMatch(/\[\[/)
    expect(body).not.toMatch(/\bfunction\s+\w+\s*\(/)
    expect(body).not.toMatch(/\$\(\(/)
  })

  it('runs to completion on this machine', () => {
    // The regression in one line: the old hook could not be started at all.
    const status = execFileSync(process.execPath, [scriptPath, '--help'], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    expect(typeof status).toBe('string')
  })
})

describe('the pre-commit checks', () => {
  it('refuses staged conflict markers and whitespace errors', () => {
    const { status, calls } = check({ statuses: { git: 1 } })
    expect(status).toBe(1)
    expect(calls[0]).toMatchObject({
      command: 'git',
      args: ['diff', '--cached', '--check'],
    })
    // Lint is not reached: the commit is already stopping.
    expect(calls).toHaveLength(1)
  })

  it('runs the lint the old hook ran', () => {
    const { status, calls } = check({})
    expect(status).toBe(0)
    expect(calls[1].args).toEqual(['lint', '--fix', '--quiet'])
  })

  it('reports the failing check status rather than a summary', () => {
    const { status } = check({
      statuses: { yarn: 3, 'yarn.cmd': 3 },
    })
    expect(status).toBe(3)
  })

  /// A fresh clone or a new worktree has no `node_modules`. Refusing to commit
  /// until someone runs an install is a worse gate than none -- the whitespace
  /// check still ran, and CI still lints.
  it('skips the lint when the toolchain is not installed, loudly', () => {
    const { status, calls, logs } = check({ installed: false })
    expect(status).toBe(0)
    expect(calls).toHaveLength(1)
    expect(logs.join(' ')).toMatch(/yarn install/)
  })

  it('passes the repository as cwd, never on the command line', () => {
    // The one value that can contain a space. On a command line it would need
    // quoting that differs per platform; as `cwd` it needs none.
    const spaced = 'C:\\Users\\Some Name\\jan'
    const { calls } = check({ root: spaced })
    for (const call of calls) {
      expect(call.cwd).toBe(spaced)
      expect(call.args.join(' ')).not.toContain('Some Name')
    }
  })

  /// Node refuses to spawn a `.cmd` without a shell since the CVE-2024-27980
  /// fix, so Windows needs one -- for Yarn only, whose arguments are all fixed
  /// literals with no spaces in them.
  it('spawns yarn the way each platform requires', () => {
    const win = check({ platform: 'win32' })
    expect(win.calls[0]).toMatchObject({ command: 'git', shell: false })
    expect(win.calls[1]).toMatchObject({ command: 'yarn.cmd', shell: true })

    const unix = check({ platform: 'linux' })
    expect(unix.calls[1]).toMatchObject({ command: 'yarn', shell: false })
  })
})
