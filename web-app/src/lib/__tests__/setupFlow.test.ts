import { describe, expect, it } from 'vitest'
import {
  engineBackendNameOf,
  FINISH_STEP,
  isPageSettled,
  isSetupStagesComplete,
  setupPageFromStages,
  WELCOME_STEP,
} from '../setupFlow'

const stage = (
  id: string,
  status: 'pending' | 'running' | 'ok' | 'warning',
  messageKey = `${id}-${status}`,
  values?: Record<string, string | number>
) => ({ id, status, messageKey, values }) as never

describe('setupPageFromStages', () => {
  it('reports a warning from any of the three first', () => {
    const page = setupPageFromStages([
      stage('engine', 'running'),
      stage('search', 'ok'),
      stage('system', 'warning'),
    ])
    expect(page).toMatchObject({ id: 'setup', status: 'warning', messageKey: 'system-warning' })
  })
  it('then the engine before search while either is unresolved', () => {
    expect(
      setupPageFromStages([stage('engine', 'running'), stage('search', 'pending')]).messageKey
    ).toBe('engine-running')
    expect(
      setupPageFromStages([stage('engine', 'ok'), stage('search', 'running')]).messageKey
    ).toBe('search-running')
  })
  it('falls back to the engine once both are ok, and to pending with no stages', () => {
    expect(
      setupPageFromStages([stage('engine', 'ok'), stage('search', 'ok')]).messageKey
    ).toBe('engine-ok')
    expect(setupPageFromStages([])).toMatchObject({ status: 'pending', messageKey: '' })
  })
})

describe('setup stage helpers', () => {
  it('is complete only when all three are ok', () => {
    const ok = [stage('engine', 'ok'), stage('search', 'ok'), stage('system', 'ok')]
    expect(isSetupStagesComplete(ok)).toBe(true)
    expect(isSetupStagesComplete(ok.slice(0, 2))).toBe(false)
  })
  it('reads the engine backend name', () => {
    expect(engineBackendNameOf([stage('engine', 'ok', 'x', { backend: 'cuda-12' })])).toBe('cuda-12')
    expect(engineBackendNameOf([])).toBe('')
  })
  it('settles welcome on start, setup on acknowledge, never finish', () => {
    const state = { hasStarted: true, isSetupSettled: false }
    expect(isPageSettled(WELCOME_STEP, state)).toBe(true)
    expect(isPageSettled({ ...WELCOME_STEP, id: 'setup' }, state)).toBe(false)
    expect(isPageSettled(FINISH_STEP, { hasStarted: true, isSetupSettled: true })).toBe(false)
  })
})
