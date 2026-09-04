import { describe, expect, it, vi } from 'vitest'
import {
  compatStateFor,
  consentStillMatches,
  fingerprintMcp,
  startImportedMcp,
  stopImportedMcp,
  type McpRuntime,
  type McpRuntimeRecord,
} from '@/lib/claudeCompatMcp'
import type { McpProbe } from '@/lib/claudeCompat'

const ROOT = '/home/dev/obs-forwarder'

const remote: McpProbe = {
  name: 'docs',
  source: 'project',
  path: `${ROOT}/.mcp.json`,
  transport: 'http',
  url: 'https://example.test/mcp',
  envNames: ['API_TOKEN'],
}

const runtime = (over: Partial<McpRuntime> = {}): McpRuntime => ({
  activate: vi.fn(async () => {}),
  deactivate: vi.fn(async () => {}),
  connected: vi.fn(async () => ['docs']),
  toolsFor: vi.fn(async () => [{ name: 'search_docs' }]),
  ...over,
})

/** Every state the record passed through, in order. */
const track = () => {
  const states: string[] = []
  const records: McpRuntimeRecord[] = []
  return {
    states,
    records,
    on: (record: McpRuntimeRecord) => {
      states.push(record.state)
      records.push(record)
    },
  }
}

describe('bringing an imported server up', () => {
  it('reaches active only after the subsystem confirms it connected', async () => {
    const seen = track()
    const result = await startImportedMcp(remote, runtime(), seen.on)

    expect(seen.states).toEqual(['initializing', 'active'])
    expect(result.tools).toEqual(['search_docs'])
  })

  /**
   * The distinction the whole module exists for. `activate` resolving means
   * the request was accepted, not that the handshake finished; a server that
   * never appears in the connected list did not come up, and calling it active
   * would advertise tools that do not exist.
   */
  it('does not call a server active just because activate resolved', async () => {
    const seen = track()
    const result = await startImportedMcp(
      remote,
      runtime({ connected: vi.fn(async () => []) }),
      seen.on
    )

    expect(result.state).toBe('init-failed')
    expect(result.reason).toBe('the server did not connect')
    expect(result.tools).toEqual([])
  })

  it('publishes no tools when the handshake failed', async () => {
    const seen = track()
    const result = await startImportedMcp(
      remote,
      runtime({
        activate: vi.fn(async () => {
          throw new Error('connection refused')
        }),
      }),
      seen.on
    )

    expect(seen.states).toEqual(['initializing', 'init-failed'])
    expect(result.reason).toContain('connection refused')
    expect(result.tools).toEqual([])
  })

  it('is not active when its tools could not be read', async () => {
    const result = await startImportedMcp(
      remote,
      runtime({
        toolsFor: vi.fn(async () => {
          throw new Error('tools/list failed')
        }),
      }),
      track().on
    )

    expect(result.state).toBe('init-failed')
  })

  it('refuses a definition with no transport it can represent', async () => {
    const seen = track()
    const result = await startImportedMcp(
      { ...remote, transport: 'websocket', url: null, command: null },
      runtime(),
      seen.on
    )

    expect(result.state).toBe('unsupported')
    expect(seen.states).toEqual(['unsupported'])
  })

  it('starts nothing it was not asked to start', async () => {
    const rt = runtime()
    await startImportedMcp(remote, rt, track().on)

    expect(rt.activate).toHaveBeenCalledTimes(1)
    expect(rt.activate).toHaveBeenCalledWith('docs', expect.objectContaining({ type: 'http' }))
  })
})

describe('taking one down', () => {
  it('reports it disabled once the subsystem has stopped it', async () => {
    const seen = track()
    const result = await stopImportedMcp('docs', 'fp', runtime(), seen.on)

    expect(seen.states).toEqual(['stopping', 'disabled'])
    expect(result.tools).toEqual([])
  })

  /**
   * A server reported stopped while its process is still up is the one lie
   * that lets a caller believe a boundary was restored when it was not.
   */
  it('never claims it stopped when shutdown failed', async () => {
    const result = await stopImportedMcp(
      'docs',
      'fp',
      runtime({
        deactivate: vi.fn(async () => {
          throw new Error('process would not exit')
        }),
      }),
      track().on
    )

    expect(result.state).not.toBe('disabled')
    expect(result.reason).toContain('process would not exit')
  })
})

/**
 * Consent means "run *this*".
 *
 * Changing what runs, where it runs, or what it is handed makes it a different
 * program — and carrying an old consent across that change would be permission
 * the user never gave.
 */
describe('the definition consent was given for', () => {
  const consented = fingerprintMcp(remote)

  it('still matches an unchanged definition', () => {
    expect(consentStillMatches(remote, consented)).toBe(true)
  })

  it.each([
    ['the endpoint', { url: 'https://evil.test/mcp' }],
    ['the transport', { transport: 'stdio' as const, command: 'sh' }],
    ['the executable', { command: 'curl', transport: 'stdio' as const }],
    ['the arguments', { args: ['--exfiltrate'] }],
    ['the environment it asks for', { envNames: ['AWS_SECRET_ACCESS_KEY'] }],
    ['where it runs', { cwd: '/home/dev/note-py' }],
  ])('is invalidated when %s changes', (_name, change) => {
    expect(consentStillMatches({ ...remote, ...change }, consented)).toBe(false)
  })

  it('is not matched by a consent that was never given', () => {
    expect(consentStillMatches(remote, undefined)).toBe(false)
  })

  // Names are part of the identity; values never reach this module.
  it('carries no secret value', () => {
    expect(consented).toContain('API_TOKEN')
    expect(consented).not.toMatch(/sk-|secret/i)
  })
})

describe('what readiness is told', () => {
  const record = (state: McpRuntimeRecord['state']): McpRuntimeRecord => ({
    state,
    tools: [],
    fingerprint: 'fp',
  })

  // Still starting is neither usable nor failed, and must not read as either.
  it.each(['initializing', 'stopping'] as const)(
    'does not show %s as active or failed',
    (state) => {
      expect(compatStateFor(record(state), 'available')).toBe('consent-required')
    }
  )

  it.each([
    ['active', 'active'],
    ['init-failed', 'init-failed'],
    ['disabled', 'disabled'],
    ['unsupported', 'unsupported'],
  ] as const)('reports %s as itself', (state, expected) => {
    expect(compatStateFor(record(state), 'available')).toBe(expected)
  })

  it('falls back to the resolver’s verdict when nothing has run', () => {
    expect(compatStateFor(undefined, 'unsupported-confinement')).toBe(
      'unsupported-confinement'
    )
  })
})
