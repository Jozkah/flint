import { describe, expect, it, beforeEach } from 'vitest'
import { useClaudeCompat } from '@/hooks/useClaudeCompat'

const ROOT = '/home/dev/obs-forwarder'
const SIBLING = '/home/dev/note-py'
const store = () => useClaudeCompat.getState()

beforeEach(() => useClaudeCompat.setState({ folders: {}, mcpConsent: {} }))

describe('switching compatibility on', () => {
  // Detection is not activation: a repository full of Claude configuration is
  // off until someone says otherwise.
  it('is off for a folder nobody has switched on', () => {
    expect(store().enabledFor(ROOT)).toBe(false)
    expect(store().enabledFor(null)).toBe(false)
  })

  it('applies to one folder, not to every folder', () => {
    store().setEnabled(ROOT, true)

    expect(store().enabledFor(ROOT)).toBe(true)
    expect(store().enabledFor(SIBLING)).toBe(false)
  })
})

describe('allowing an MCP server', () => {
  it('is per folder and per server', () => {
    store().setEnabled(ROOT, true)
    store().setMcpConsent(ROOT, 'docs', true)

    expect(store().consentedMcp(ROOT)).toEqual(new Set(['docs']))
    expect(store().consentedMcp(SIBLING)).toEqual(new Set())
  })

  it('can be withdrawn', () => {
    store().setMcpConsent(ROOT, 'docs', true)
    store().setMcpConsent(ROOT, 'docs', false)

    expect(store().consentedMcp(ROOT)).toEqual(new Set())
  })

  // Otherwise switching compatibility off and on again would silently restore
  // every process the user had ever allowed.
  it('is withdrawn when compatibility is switched off', () => {
    store().setEnabled(ROOT, true)
    store().setMcpConsent(ROOT, 'docs', true)

    store().setEnabled(ROOT, false)

    expect(store().consentedMcp(ROOT)).toEqual(new Set())
  })

  /**
   * Consent is never written to storage.
   *
   * Allowing a server means allowing a process. A consent restored at launch
   * would start it on a decision made weeks ago that the user cannot see, so
   * only the opt-in itself survives a restart.
   */
  it('is never part of what gets persisted', () => {
    store().setEnabled(ROOT, true)
    store().setMcpConsent(ROOT, 'docs', true)

    const persisted = useClaudeCompat.persist.getOptions().partialize?.(
      useClaudeCompat.getState()
    )

    expect(persisted).toEqual({ folders: { [ROOT]: true } })
    expect(JSON.stringify(persisted)).not.toContain('docs')
  })
})
