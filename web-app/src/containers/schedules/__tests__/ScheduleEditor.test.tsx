import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import schedules from '@/locales/en/schedules.json'
import common from '@/locales/en/common.json'
import rooms from '@/locales/en/rooms.json'
import { ScheduleEditor } from '../ScheduleEditor'
import { validateForm, newTaskForm } from '../scheduleForm'
import type { ScheduledTask } from '@/lib/schedules'

const bundles: Record<string, unknown> = { schedules, common, rooms }

function t(key: string, options: Record<string, unknown> = {}): string {
  const [ns, path] = key.includes(':') ? key.split(':') : ['common', key]
  const value = path
    .split('.')
    .reduce<unknown>(
      (cur, part) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined),
      bundles[ns]
    )
  if (typeof value !== 'string') return key
  return value.replace(/\{\{(\w+)\}\}/g, (m, v) => (options[v] !== undefined ? String(options[v]) : m))
}

vi.mock('@/i18n/react-i18next-compat', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (sel: (s: { providers: unknown }) => unknown) =>
    sel({
      providers: [
        {
          provider: 'openai',
          active: true,
          api_key: 'k',
          settings: [],
          models: [{ id: 'gpt-x', name: 'GPT X', capabilities: [] }],
        },
      ],
    }),
}))
const open = vi.fn()
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ dialog: () => ({ open }) }),
}))

const preview = vi.fn()
vi.mock('@/lib/schedules', async () => {
  const actual = await vi.importActual<typeof import('@/lib/schedules')>('@/lib/schedules')
  return {
    ...actual,
    schedulePreview: (...args: unknown[]) => preview(...args),
    scheduleTimeZones: async () => ['UTC', 'Europe/Berlin'],
    scheduleTools: async () => [
      { name: 'read', capability: 'read' },
      { name: 'write', capability: 'write' },
    ],
  }
})

describe('ScheduleEditor', () => {
  beforeEach(() => {
    preview.mockReset()
    preview.mockResolvedValue(['2026-05-02T09:00:00Z', '2026-05-03T09:00:00Z'])
    open.mockReset()
  })

  it('refuses to save an empty form and says what is missing', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(true)
    render(<ScheduleEditor open task={null} onClose={() => {}} onSave={onSave} />)
    await user.click(screen.getByRole('button', { name: 'Save task' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(await screen.findByText('Give the task a name.')).toBeInTheDocument()
    expect(screen.getByText('Choose a model.')).toBeInTheDocument()
    expect(screen.getByText('Choose a project folder.')).toBeInTheDocument()
  })

  it('shows what the preset compiles to and the next runs', async () => {
    const user = userEvent.setup()
    render(<ScheduleEditor open task={null} onClose={() => {}} onSave={vi.fn()} />)
    expect(screen.getByTestId('compiled-cron')).toHaveTextContent('0 9 * * *')
    // Adding a second time on another minute adds a second expression.
    const time = screen.getByLabelText('Time of day')
    await user.clear(time)
    await user.type(time, '17:30')
    await user.click(screen.getByRole('button', { name: 'Add time' }))
    expect(screen.getByTestId('compiled-cron')).toHaveTextContent('0 9 * * *')
    expect(screen.getByTestId('compiled-cron')).toHaveTextContent('30 17 * * *')
    await waitFor(() => expect(preview).toHaveBeenCalled())
    const last = preview.mock.calls.at(-1)!
    expect(last[0]).toMatchObject({ kind: 'daily' })
    expect(await screen.findByTestId('next-fires')).toHaveTextContent('Next runs')
  })

  it('turns a preset into editable cron text when one expression says it all', async () => {
    const user = userEvent.setup()
    render(<ScheduleEditor open task={null} onClose={() => {}} onSave={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Edit as cron' }))
    expect(screen.getByLabelText('Cron expression')).toHaveValue('0 9 * * *')
  })

  it('saves a complete task with the budgets and the allow-list', async () => {
    const user = userEvent.setup()
    open.mockResolvedValue('C:/work/repo')
    const onSave = vi.fn().mockResolvedValue(true)
    const onClose = vi.fn()
    render(<ScheduleEditor open task={null} onClose={onClose} onSave={onSave} />)

    await user.type(screen.getByLabelText('Name'), 'Morning digest')
    await user.type(screen.getByLabelText('What should it do?'), 'Summarise the repo.')
    await user.click(screen.getByLabelText('Model'))
    await user.click(await screen.findByRole('menuitemradio', { name: /^GPT X/ }))
    await user.click(screen.getByRole('button', { name: 'Choose folder' }))
    await screen.findByText('C:/work/repo')
    await user.click(await screen.findByLabelText(/^write/))
    await user.click(screen.getByRole('button', { name: 'Save task' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const saved = onSave.mock.calls[0][0] as ScheduledTask
    expect(saved).toMatchObject({
      name: 'Morning digest',
      model: 'openai/gpt-x',
      project: 'C:/work/repo',
      schedule: { kind: 'daily', times: [{ hour: 9, minute: 0 }] },
      policy: { write: 'read_only' },
      budgets: { maxTurns: 20, maxTokens: 200000, maxWallClockSecs: 900 },
    })
    expect(saved.policy.allowTools).toEqual(['read', 'ls', 'find', 'grep', 'write'])
    expect(onClose).toHaveBeenCalled()
  })

  it('has an English message for every error the form can raise', () => {
    const blank = { ...newTaskForm({ timezone: '' }), allowTools: [], maxTurns: '0', maxTokens: '0', maxMinutes: '0' }
    const keys = Object.values({
      ...validateForm(blank),
      ...validateForm({
        ...blank,
        schedule: { preset: 'weekly', times: ['9am'], days: [], cron: '' },
      }),
      ...validateForm({ ...blank, schedule: { preset: 'cron', times: [], days: [], cron: '' } }),
      ...validateForm({ ...blank, schedule: { preset: 'daily', times: [], days: [], cron: '' } }),
    })
    expect(keys.length).toBeGreaterThan(8)
    for (const key of keys) expect(t(key as string), key as string).not.toBe(key)
  })
})
