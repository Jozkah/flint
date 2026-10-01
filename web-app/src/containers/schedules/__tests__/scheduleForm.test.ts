import { describe, expect, it } from 'vitest'
import {
  formToCron,
  formToSchedule,
  formToTask,
  newTaskForm,
  parseTime,
  scheduleToForm,
  taskToForm,
  toCronForm,
  validateForm,
  type ScheduleForm,
  type TaskForm,
} from '../scheduleForm'

const form = (over: Partial<ScheduleForm>): ScheduleForm => ({
  preset: 'daily',
  times: ['09:00'],
  days: [1, 2, 3, 4, 5],
  cron: '',
  ...over,
})

const valid = (over: Partial<TaskForm> = {}): TaskForm => ({
  ...newTaskForm({ timezone: 'Europe/Berlin' }),
  name: 'Morning digest',
  prompt: 'Summarise what changed.',
  model: 'openai/gpt-x',
  project: 'C:/work/repo',
  ...over,
})

describe('form to cron', () => {
  // The same strings core/schedule/spec.rs asserts in `presets_compile_to_cron`.
  it('compiles the presets the way the engine does', () => {
    expect(formToCron(form({ preset: 'daily' }))).toEqual(['0 9 * * *'])
    expect(formToCron(form({ preset: 'weekdays', times: ['08:30'] }))).toEqual([
      '30 8 * * 1-5',
    ])
    expect(
      formToCron(form({ preset: 'weekly', days: [5, 1, 1], times: ['07:15'] }))
    ).toEqual(['15 7 * * 1,5'])
  })

  it('shares an expression between times on the same minute and sorts them', () => {
    expect(
      formToCron(form({ times: ['17:30', '13:00', '09:00', '09:00'] }))
    ).toEqual(['0 9,13 * * *', '30 17 * * *'])
  })

  it('passes a raw cron expression through untouched', () => {
    expect(formToCron(form({ preset: 'cron', cron: ' */10 * * * * ' }))).toEqual([
      '*/10 * * * *',
    ])
    expect(formToCron(form({ preset: 'cron', cron: '  ' }))).toEqual([])
  })

  it('compiles to nothing while the form is incomplete', () => {
    expect(formToCron(form({ times: [] }))).toEqual([])
    expect(formToCron(form({ times: ['25:00'] }))).toEqual([])
    expect(formToCron(form({ preset: 'weekly', days: [] }))).toEqual([])
  })
})

describe('form to schedule and back', () => {
  it('round-trips every preset', () => {
    const cases: ScheduleForm[] = [
      form({ preset: 'daily', times: ['06:00', '18:45'] }),
      form({ preset: 'weekdays', times: ['08:30'] }),
      form({ preset: 'weekly', days: [0, 6], times: ['10:00'] }),
      form({ preset: 'cron', cron: '0 */2 * * *' }),
    ]
    for (const c of cases) {
      const spec = formToSchedule(c)
      expect(spec).not.toBeNull()
      const back = scheduleToForm(spec!)
      expect(formToCron(back)).toEqual(formToCron(c))
    }
  })

  it('stores times as hour and minute numbers, earliest first', () => {
    expect(formToSchedule(form({ times: ['17:05', '09:00'] }))).toEqual({
      kind: 'daily',
      times: [
        { hour: 9, minute: 0 },
        { hour: 17, minute: 5 },
      ],
    })
  })

  it('refuses to make a schedule from an empty form', () => {
    expect(formToSchedule(form({ times: [] }))).toBeNull()
    expect(formToSchedule(form({ preset: 'weekly', days: [] }))).toBeNull()
    expect(formToSchedule(form({ preset: 'cron', cron: '' }))).toBeNull()
  })

  it('switches to cron text only when one expression says it all', () => {
    const one = toCronForm(form({ times: ['09:00', '13:00'] }))
    expect(one).toMatchObject({ preset: 'cron', cron: '0 9,13 * * *' })
    expect(toCronForm(form({ times: ['09:00', '17:30'] }))).toBeNull()
  })
})

describe('parseTime', () => {
  it('accepts 24-hour times and nothing else', () => {
    expect(parseTime('9:05')).toEqual({ hour: 9, minute: 5 })
    expect(parseTime('23:59')).toEqual({ hour: 23, minute: 59 })
    expect(parseTime('24:00')).toBeNull()
    expect(parseTime('09:60')).toBeNull()
    expect(parseTime('nine')).toBeNull()
  })
})

describe('validation', () => {
  it('accepts a complete form', () => {
    expect(validateForm(valid())).toEqual({})
  })

  it('names what is missing', () => {
    const errors = validateForm(
      valid({ name: ' ', prompt: '', model: '', project: '', allowTools: [] })
    )
    expect(Object.keys(errors).sort()).toEqual(
      ['model', 'name', 'project', 'prompt', 'tools'].sort()
    )
  })

  it('holds the budgets to the same limits as the engine', () => {
    expect(validateForm(valid({ maxTurns: '0' })).maxTurns).toBeDefined()
    expect(validateForm(valid({ maxTurns: '201' })).maxTurns).toBeDefined()
    expect(validateForm(valid({ maxTurns: '200' })).maxTurns).toBeUndefined()
    expect(validateForm(valid({ maxTokens: '5000001' })).maxTokens).toBeDefined()
    expect(validateForm(valid({ maxTokens: 'lots' })).maxTokens).toBeDefined()
    expect(validateForm(valid({ maxMinutes: '361' })).maxMinutes).toBeDefined()
    expect(validateForm(valid({ maxMinutes: '' })).maxMinutes).toBeDefined()
  })

  it('checks the schedule fields of the chosen preset only', () => {
    expect(
      validateForm(valid({ schedule: form({ preset: 'weekly', days: [] }) })).days
    ).toBeDefined()
    expect(
      validateForm(valid({ schedule: form({ preset: 'daily', days: [] }) })).days
    ).toBeUndefined()
    expect(
      validateForm(valid({ schedule: form({ preset: 'cron', cron: '' }) })).cron
    ).toBeDefined()
    expect(
      validateForm(valid({ schedule: form({ times: ['9am'] }) })).times
    ).toBeDefined()
  })
})

describe('form to task', () => {
  it('builds the task the backend stores, with minutes turned into seconds', () => {
    const result = formToTask(valid({ maxMinutes: '15', write: 'worktree' }))
    if (!('task' in result)) throw new Error('expected a task')
    expect(result.task).toMatchObject({
      name: 'Morning digest',
      timezone: 'Europe/Berlin',
      schedule: { kind: 'daily', times: [{ hour: 9, minute: 0 }] },
      policy: { allowTools: ['read', 'ls', 'find', 'grep'], write: 'worktree' },
      budgets: { maxTurns: 20, maxTokens: 200000, maxWallClockSecs: 900 },
      onBlock: 'continue',
      catchUp: 'once',
      profile: null,
      enabled: true,
    })
  })

  it('returns the errors instead of a task when the form is not valid', () => {
    const result = formToTask(valid({ name: '' }))
    expect('errors' in result && result.errors.name).toBeDefined()
  })

  it('keeps a task unchanged through the editor', () => {
    const made = formToTask(
      valid({ id: 'task-1', profile: 'ci', catchUp: 'all_capped', onBlock: 'end' })
    )
    if (!('task' in made)) throw new Error('expected a task')
    const again = formToTask(taskToForm(made.task))
    expect('task' in again && again.task).toEqual(made.task)
  })

  it('always carries the three budgets', () => {
    const made = formToTask(valid())
    if (!('task' in made)) throw new Error('expected a task')
    for (const v of Object.values(made.task.budgets)) expect(v).toBeGreaterThan(0)
  })
})
