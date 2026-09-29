import { describe, expect, it } from 'vitest'
import {
  classifyStableFailure,
  detectLoop,
  type ObservedCall,
} from '../runLoopGuard'

const failed = (
  tool: string,
  input: unknown,
  error: string
): ObservedCall => ({ tool, input, failed: true, error })

const noNetwork = (command: string): ObservedCall =>
  failed(
    'bash',
    { command },
    "npm ERR! network request failed: No such host is known\n" +
      '[sandbox: the shell has no network access; do not retry downloads.]'
  )

const unavailableToolchain = (
  name: string,
  command: string,
  installed = true
): ObservedCall =>
  failed(
    'bash',
    { command },
    installed
      ? `${name} : The term '${name}' is not recognized as the name of a cmdlet\n` +
          `[sandbox: \`${name}\` is installed at C:\\Tools\\${name}\\${name}.exe but this sandbox cannot run it: its folder is not on the sandbox PATH. Do not search the disk for another copy, run a runtime bundled with another application, probe settings, or retry until the user acts.]`
      : `${name} : The term '${name}' is not recognized as the name of a cmdlet\n` +
          `[sandbox: \`${name}\` is not available in this sandbox. Do not search the disk or user profile for it, do not download or install it, and do not retry; tell the user the command to run themselves and treat the check as not run.]`
  )

describe('stable environment blockers', () => {
  it('stops equivalent download retries once network is known to be disabled', () => {
    expect(classifyStableFailure('bash', noNetwork('npm install').error)).toBe(
      'network disabled for this run'
    )
    expect(detectLoop([noNetwork('npm install')])).toEqual({ tripped: false })
    expect(
      detectLoop([
        noNetwork('npm install'),
        noNetwork('node npm-cli.js install'),
      ])
    ).toMatchObject({ tripped: true, reason: 'failing-shell' })
  })

  it('scopes an unavailable toolchain by program instead of conflating all missing programs', () => {
    const node = unavailableToolchain('node', 'node --version')
    const cargo = unavailableToolchain('cargo', 'cargo --version')

    expect(classifyStableFailure('bash', node.error)).toBe(
      'toolchain unavailable in sandbox'
    )
    expect(detectLoop([node, cargo])).toEqual({ tripped: false })
    expect(
      detectLoop([
        node,
        unavailableToolchain('node', 'node ./scripts/check.js', false),
      ])
    ).toMatchObject({ tripped: true, reason: 'failing-shell' })
  })

  it('stops repeated oversized bash timeouts even when the commands differ', () => {
    const timeout = (command: string, seconds: number): ObservedCall =>
      failed(
        'bash',
        { command, timeout: seconds },
        `bash timeout ${seconds}s exceeds the 120s foreground limit. ` +
          'Use timeout <= 120, or set background: true and omit timeout for longer work. ' +
          'Do not retry with a larger timeout.'
      )

    expect(classifyStableFailure('bash', timeout('a', 600).error)).toBe(
      'bash timeout exceeds limit'
    )
    expect(detectLoop([timeout('a', 600), timeout('b', 300)])).toMatchObject({
      tripped: true,
      reason: 'failing-shell',
    })
  })

  it('stops re-dispatching the same exhausted subagent but not a different one', () => {
    const exhausted = (name: string, cap: string): ObservedCall =>
      failed(
        'task',
        { subagent_name: name, description: 'check the implementation' },
        `The subagent '${name}' stopped at ${cap} without finishing.`
      )

    const reviewer = exhausted('reviewer', 'its 20-step budget')
    const tester = exhausted('tester', 'the session token budget')
    expect(classifyStableFailure('task', reviewer.error)).toBe(
      'subagent exhausted its run'
    )
    expect(detectLoop([reviewer, tester])).toEqual({ tripped: false })
    expect(
      detectLoop([
        reviewer,
        exhausted('reviewer', 'a repeating loop it could not get out of'),
      ])
    ).toMatchObject({ tripped: true, reason: 'failing-tool' })
  })

  it('does not treat a repairable PowerShell masked failure as a permanent blocker', () => {
    const one = failed(
      'bash',
      { command: 'go vet ./...; "EXIT=$LASTEXITCODE"' },
      '[shell: reported exit 0, but a command inside it exited with 2. Check $LASTEXITCODE with if or run the step on its own.]'
    )
    const two = failed(
      'bash',
      { command: 'npm test; "EXIT=$LASTEXITCODE"' },
      '[shell: reported exit 0, but a command inside it exited with 1. Check $LASTEXITCODE with if or run the step on its own.]'
    )

    expect(classifyStableFailure('bash', one.error)).toBeNull()
    expect(detectLoop([one, two])).toEqual({ tripped: false })
  })
})
