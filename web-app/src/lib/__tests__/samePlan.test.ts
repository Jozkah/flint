import { describe, it, expect } from 'vitest'
import { samePlan } from '@/lib/todoLabels'
import type { TodoList } from '@/types/coworkSession'

const plan = (...tasks: [string, 'pending' | 'in_progress' | 'completed'][]): TodoList =>
  ({ phases: [{ name: 'Fix', tasks: tasks.map(([content, status]) => ({ content, status })) }] }) as unknown as TodoList

describe('samePlan', () => {
  it('is true for the same steps in the same states', () => {
    expect(samePlan(plan(['a', 'completed'], ['b', 'in_progress']), plan(['a', 'completed'], ['b', 'in_progress']))).toBe(true)
  })
  it('is false when a state or a step differs', () => {
    expect(samePlan(plan(['a', 'completed']), plan(['a', 'pending']))).toBe(false)
    expect(samePlan(plan(['a', 'completed']), plan(['a', 'completed'], ['b', 'pending']))).toBe(false)
  })
  it('treats two empty plans as the same', () => {
    expect(samePlan(undefined, undefined)).toBe(true)
  })
})
