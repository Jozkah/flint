import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { TimeChips } from '../TimeChips'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.time ? `${key}:${String(opts.time)}` : key,
  }),
  i18n: { t: (key: string) => key },
}))

describe('TimeChips (P2E-026)', () => {
  it('says why a duplicate time was not added', () => {
    const onChange = vi.fn()
    render(<TimeChips id="t" times={['12:00']} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'schedules:editor.addTime' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('schedules:editor.timeDuplicate:12:00')
  })

  it('says why an empty time was not added, and clears once edited', () => {
    const onChange = vi.fn()
    render(<TimeChips id="t" times={[]} onChange={onChange} />)
    const input = screen.getByLabelText('schedules:editor.timeLabel')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'schedules:editor.addTime' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('schedules:editor.timeInvalid')
    fireEvent.change(input, { target: { value: '08:30' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'schedules:editor.addTime' }))
    expect(onChange).toHaveBeenCalledWith(['08:30'])
  })
})
