import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { OctagonAlert } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  getMatrix,
  listProjects,
  setItemSurfaces,
  type ExtensionKind,
  type ExtensionsMatrix,
  type ProjectEntry,
} from '@/lib/extensionsStore'

export interface EnablementGridProps {
  kind: ExtensionKind
  id: string
}

interface Column {
  key: string
  label: string
}

/** The item's surface key set (from the matrix), or `null` when unset (=> all enabled). */
function surfacesFor(
  matrix: ExtensionsMatrix | null,
  kind: ExtensionKind,
  id: string
): string[] | null {
  if (!matrix) return null
  const bucket = kind === 'plugin' ? matrix.plugins : matrix.skills
  const entry = bucket[id]
  return entry ? entry.surfaces : null
}

/**
 * A checkbox grid for one skill/plugin's per-surface enablement: Home,
 * Rooms, and one column per registered project. An item absent from the
 * matrix renders every box checked (default: enabled everywhere). Toggling a
 * cell recomputes the full boolean vector across every known surface and
 * writes it back in one shot via `setItemSurfaces` -- all-checked collapses
 * to clearing the item back to its default.
 */
export default function EnablementGrid({ kind, id }: EnablementGridProps) {
  const { t } = useTranslation()
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [matrix, setMatrix] = useState<ExtensionsMatrix | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingKey, setPendingKey] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [m, p] = await Promise.all([getMatrix(), listProjects()])
      setMatrix(m)
      setProjects(p)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const columns: Column[] = [
    { key: 'home', label: t('common:extensions.surfaces.home', undefined) ?? 'Home' },
    { key: 'rooms', label: t('common:extensions.surfaces.rooms', undefined) ?? 'Rooms' },
    ...projects.map((p) => ({ key: `cowork:${p.id}`, label: p.name || p.folder })),
  ]

  const currentSurfaces = surfacesFor(matrix, kind, id)
  const isChecked = (columnKey: string) =>
    currentSurfaces === null ? true : currentSurfaces.includes(columnKey)

  const toggle = async (columnKey: string, checked: boolean) => {
    if (!matrix) return
    const allKeys = columns.map((c) => c.key)
    const before = currentSurfaces === null ? [...allKeys] : [...currentSurfaces]
    const next = checked
      ? Array.from(new Set([...before, columnKey]))
      : before.filter((k) => k !== columnKey)
    const allChecked = allKeys.every((k) => next.includes(k))
    const nextSurfaces = allChecked ? null : next

    const bucketKey = kind === 'plugin' ? 'plugins' : 'skills'
    const optimistic: ExtensionsMatrix = {
      ...matrix,
      [bucketKey]: {
        ...matrix[bucketKey],
        ...(nextSurfaces === null
          ? (() => {
              const rest = { ...matrix[bucketKey] }
              delete rest[id]
              return rest
            })()
          : { [id]: { surfaces: nextSurfaces } }),
      },
    }

    setPendingKey(columnKey)
    setError(null)
    setMatrix(optimistic)
    try {
      const result = await setItemSurfaces(kind, id, nextSurfaces)
      setMatrix(result)
    } catch (e) {
      setMatrix(matrix)
      const message = String(e)
      setError(message)
      toast.error(message)
    } finally {
      setPendingKey(null)
    }
  }

  if (loading && !matrix) {
    return (
      <div className="text-xs text-muted-foreground">{t('common:loading', undefined) ?? 'Loading…'}</div>
    )
  }

  return (
    <div className="flex flex-col gap-2" data-testid="enablement-grid">
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive break-words">
          <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{error}</span>
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        {columns.map((col) => {
          const checkboxId = `enablement-${kind}-${id}-${col.key}`
          return (
            <div key={col.key} className="flex items-center gap-2">
              <input
                type="checkbox"
                id={checkboxId}
                className="size-3.5 shrink-0"
                checked={isChecked(col.key)}
                disabled={pendingKey === col.key}
                onChange={(e) => void toggle(col.key, e.target.checked)}
              />
              <Label htmlFor={checkboxId} className="text-xs font-normal">
                {col.label}
              </Label>
            </div>
          )
        })}
      </div>
    </div>
  )
}
