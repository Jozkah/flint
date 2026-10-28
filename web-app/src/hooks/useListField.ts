import { useCallback, useState } from 'react'
import { arrayMove } from '@dnd-kit/sortable'

/**
 * Editable list of form rows. Removing the last row leaves one empty row so
 * the form always shows an input.
 */
export const listAppend = (items: string[]): string[] => [...items, '']

export const listRemoveAt = (items: string[], index: number): string[] => {
  const next = [...items]
  next.splice(index, 1)
  return next.length > 0 ? next : ['']
}

export const listSetAt = (
  items: string[],
  index: number,
  value: string
): string[] => {
  const next = [...items]
  next[index] = value
  return next
}

export function useListField(initial: string[] = ['']) {
  const [items, setItems] = useState<string[]>(initial)
  const add = useCallback(() => setItems((prev) => listAppend(prev)), [])
  const remove = useCallback(
    (index: number) => setItems((prev) => listRemoveAt(prev, index)),
    []
  )
  const update = useCallback(
    (index: number, value: string) =>
      setItems((prev) => listSetAt(prev, index, value)),
    []
  )
  const move = useCallback(
    (from: number, to: number) => setItems((prev) => arrayMove(prev, from, to)),
    []
  )
  /** Replace all rows; an empty list becomes one empty row. */
  const reset = useCallback(
    (next: string[] = ['']) => setItems(next.length > 0 ? next : ['']),
    []
  )
  return { items, add, remove, update, move, reset }
}

/** Parallel key/value rows (env vars, headers) kept the same length. */
export function useKeyValueListField() {
  const keys = useListField()
  const values = useListField()
  const { add: addKey, remove: removeKey, reset: resetKeys } = keys
  const { add: addValue, remove: removeValue, reset: resetValues } = values
  const add = useCallback(() => {
    addKey()
    addValue()
  }, [addKey, addValue])
  const remove = useCallback(
    (index: number) => {
      removeKey(index)
      removeValue(index)
    },
    [removeKey, removeValue]
  )
  /** Load from a record; an empty or missing record leaves one empty row. */
  const resetFrom = useCallback(
    (record?: Record<string, string>) => {
      const k = Object.keys(record ?? {})
      resetKeys(k)
      resetValues(k.map((key) => (record as Record<string, string>)[key]))
    },
    [resetKeys, resetValues]
  )
  return {
    keys: keys.items,
    values: values.items,
    add,
    remove,
    updateKey: keys.update,
    updateValue: values.update,
    resetFrom,
  }
}
