import { describe, expect, it, vi } from 'vitest'

// The store persists through Jan's settings store on the desktop. Here it
// persists to a file the next process will read, which is what makes this a
// restart rather than a reset.
vi.mock('@/lib/backendStorage', async () => {
  const { fileStorage } = await import('./persistProcess')
  return { backendStorage: fileStorage }
})

const { useClaudeCompat } = await import('@/hooks/useClaudeCompat')

const ROOT = '/home/dev/obs-forwarder'

/**
 * Process A: a session that enabled compatibility and allowed a server.
 *
 * It writes exactly what Jan writes, then exits. Nothing here asserts the
 * restart behaviour — that is process B's job.
 */
/**
 * Driven by `scripts/cowork-compat-smoke.sh`, which supplies the shared file.
 *
 * Skipped rather than failed when it is absent, because the default runner
 * picks this file up too and a two-process fixture cannot work in one process.
 * Skipping rather than excluding the directory is deliberate: a skipped spec
 * still names itself in the output, so the coverage it represents is visibly
 * absent instead of silently missing.
 */
const withFixture = describe.skipIf(!process.env.JAN_RESTART_FIXTURE)

withFixture('process A: a session that used compatibility', () => {
  it('switches compatibility on and allows an imported server', async () => {
    const store = useClaudeCompat.getState()

    store.setEnabled(ROOT, true)
    store.setMcpConsent(ROOT, 'docs', true)
    store.setMcpFingerprint(ROOT, 'docs', 'fingerprint-for-docs')
    store.setMcpRuntime(ROOT, 'docs', {
      state: 'active',
      tools: ['search_docs'],
      fingerprint: 'fingerprint-for-docs',
    })
    store.setSkillRoots(['/home/dev/.claude/skills'])

    expect(useClaudeCompat.getState().enabledFor(ROOT)).toBe(true)
    expect(useClaudeCompat.getState().consentedMcp(ROOT)).toEqual(
      new Set(['docs'])
    )

    // Let the persist middleware flush to the shared file.
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
})
