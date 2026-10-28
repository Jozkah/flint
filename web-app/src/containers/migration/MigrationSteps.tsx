import { useMemo } from 'react'
import { Switch } from '@/components/ui/switch'
import { Select } from '@/components/ui/select'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  ALL_CATEGORIES,
  MODE_LABELS,
  CONFLICT_LABELS,
  formatBytes,
  type Category,
  type Conflict,
  type DetectResult,
  type MigrationMode,
  type MigrationPlan,
  type MigrationResult,
} from '@/lib/migration'

export const COPY_LIKE: MigrationMode[] = ['copy', 'move']

/** Render a translated sentence with `path` shown in a monospace span. */
export function withPath(text: string, path: string) {
  const parts = text.split(path)
  if (parts.length !== 2) return text
  return (
    <>
      {parts[0]}
      <span className="font-mono break-all">{path}</span>
      {parts[1]}
    </>
  )
}

/** The translated labels the three steps share. */
function useLabels() {
  const { t } = useTranslation()
  return {
    t,
    modeDescription: (m: MigrationMode) =>
      m === 'copy'
        ? t('common:migration.copyDescription')
        : m === 'fresh'
          ? t('common:migration.freshDescription')
          : t(`common:migration.modes.${m}.description`),
    modeLabel: (m: MigrationMode) => t(`common:migration.modes.${m}.label`),
    categoryLabel: (c: Category) => t(`common:migration.categories.${c}`),
    conflictLabel: (c: Conflict) => t(`common:migration.conflicts.${c}`),
  }
}

/** Step 1: how to bring the data across, and which categories. */
export function MigrationChooseStep({
  detect,
  mode,
  onModeChange,
  selected,
  onToggleCategory,
  defaultConflict,
  onDefaultConflictChange,
}: {
  detect: DetectResult | null
  mode: MigrationMode
  onModeChange: (m: MigrationMode) => void
  selected: Set<Category>
  onToggleCategory: (c: Category) => void
  defaultConflict: Conflict
  onDefaultConflictChange: (c: Conflict) => void
}) {
  const { t, modeDescription, modeLabel, categoryLabel, conflictLabel } =
    useLabels()
  const legacyCategories = useMemo(() => {
    const byId = new Map(
      (detect?.legacy?.categories ?? []).map((c) => [c.category, c])
    )
    return ALL_CATEGORIES.map((id) => ({
      id,
      report: byId.get(id),
    })).filter((c) => c.report) // only categories the core reported
  }, [detect])
  const setMode = onModeChange
  const toggleCategory = onToggleCategory
  const setDefaultConflict = onDefaultConflictChange
  return (
      <div className="flex flex-col gap-4">
        {detect?.legacy && (
          <div className="rounded-md border border-foreground/10 bg-foreground/5 px-3 py-2 text-xs text-muted-foreground">
            {withPath(
              t('common:migration.foundAt', {
                path: detect.legacy.source.data_folder,
                size: formatBytes(detect.legacy.total_size_bytes),
              }),
              detect.legacy.source.data_folder
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {t('common:migration.chooseNote')}
        </p>

        <div className="flex flex-col gap-2">
          {(Object.keys(MODE_LABELS) as MigrationMode[]).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              data-testid={`mode-${m}`}
              onClick={() => setMode(m)}
              className={
                'text-left rounded-md border px-3 py-2 transition-colors ' +
                (mode === m
                  ? 'border-primary/60 bg-primary/10'
                  : 'border-foreground/10 hover:bg-foreground/5')
              }
            >
              <div className="text-sm font-medium">{modeLabel(m)}</div>
              <div className="text-xs text-muted-foreground">
                {modeDescription(m)}
              </div>
            </button>
          ))}
        </div>

        {COPY_LIKE.includes(mode) && (
          <div className="flex flex-col gap-2">
            <div className="text-xs font-medium text-muted-foreground">
              {t('common:migration.whatToBring')}
            </div>
            {legacyCategories.map(({ id, report }) => (
              <label
                key={id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="flex flex-col">
                  <span>{categoryLabel(id)}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatBytes(report?.size_bytes ?? 0)} ·{' '}
                    {t('common:migration.fileCount', {
                      count: report?.file_count ?? 0,
                    })}
                  </span>
                </span>
                <Switch
                  checked={selected.has(id)}
                  onCheckedChange={() => toggleCategory(id)}
                  aria-label={categoryLabel(id)}
                />
              </label>
            ))}

            <label className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{t('common:migration.existsInFlint')}</span>
              <Select
                className="rounded-md border border-foreground/15 bg-transparent px-2 py-1 text-xs"
                value={defaultConflict}
                onChange={(e) =>
                  setDefaultConflict(e.target.value as Conflict)
                }
                aria-label={t('common:migration.conflictAria')}
              >
                {(Object.keys(CONFLICT_LABELS) as Conflict[]).map((c) => (
                  <option key={c} value={c}>
                    {conflictLabel(c)}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        )}
      </div>
  )
}

/** Step 2: the plan the core built, with conflicts and warnings. */
export function MigrationReviewStep({
  plan,
  defaultConflict,
  onDefaultConflictChange,
  onReplan,
}: {
  plan: MigrationPlan
  defaultConflict: Conflict
  onDefaultConflictChange: (c: Conflict) => void
  /** Re-plan so a changed resolution is applied and re-reviewed. */
  onReplan: (c: Conflict) => void
}) {
  const { t, modeLabel, conflictLabel } = useLabels()
  const conflicts = useMemo(
    () => plan.items.filter((i) => i.conflict),
    [plan]
  )
  const setDefaultConflict = onDefaultConflictChange
  const buildPlan = onReplan
  return (
      <div className="flex flex-col gap-3">
        {!plan.compatible && (
          <p role="alert" className="text-xs text-destructive">
            {t('common:migration.incompatible')}
          </p>
        )}
        <div className="rounded-md border border-foreground/10 px-3 py-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('common:migration.mode')}</span>
            <span className="font-medium">{modeLabel(plan.mode)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('common:migration.items')}</span>
            <span>{plan.items.length}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('common:migration.estimatedSize')}</span>
            <span>{formatBytes(plan.estimated_bytes)}</span>
          </div>
          {plan.reuse_path && (
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">{t('common:migration.reusePath')}</span>
              <span className="font-mono text-xs break-all">
                {plan.reuse_path}
              </span>
            </div>
          )}
        </div>

        {conflicts.length > 0 && (
          <div className="rounded-md border border-foreground/10 px-3 py-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium">
                {t('common:migration.conflictCount', {
                  count: conflicts.length,
                })}
              </span>
              <Select
                className="rounded-md border border-foreground/15 bg-transparent px-2 py-1 text-xs"
                value={defaultConflict}
                onChange={(e) => {
                  const c = e.target.value as Conflict
                  setDefaultConflict(c)
                  // Re-plan so the resolution is applied and re-reviewed.
                  void buildPlan(c)
                }}
                aria-label={t('common:migration.resolveAria')}
              >
                {(Object.keys(CONFLICT_LABELS) as Conflict[]).map((c) => (
                  <option key={c} value={c}>
                    {conflictLabel(c)}
                  </option>
                ))}
              </Select>
            </div>
            <ul className="max-h-28 overflow-y-auto text-xs text-muted-foreground">
              {conflicts.slice(0, 50).map((i) => (
                <li key={i.destination} className="truncate">
                  {i.name}
                  {i.conflict?.flint_is_newer
                    ? ` — ${t('common:migration.flintIsNewer')}`
                    : ''}
                </li>
              ))}
            </ul>
          </div>
        )}

        {plan.warnings.length > 0 && (
          <ul className="text-xs text-amber-600 dark:text-amber-500">
            {plan.warnings.map((w, i) => (
              <li key={i}>• {w}</li>
            ))}
          </ul>
        )}
      </div>
  )
}

/** Step 4: what happened, success or failure. */
export function MigrationResultStep({
  result,
  error,
  rolledBack,
}: {
  result: MigrationResult | null
  error: string | null
  rolledBack: boolean
}) {
  const { t, categoryLabel } = useLabels()
  return (
      <div className="flex flex-col gap-3 py-1 text-sm">
        {result && result.status === 'complete' && !result.error ? (
          <>
            <div className="font-medium text-green-600 dark:text-green-500">
              {t('common:migration.complete')}
            </div>
            <ul className="text-xs text-muted-foreground">
              {result.per_category.map((c) => (
                <li key={c.category}>
                  {t('common:migration.categoryOk', {
                    name: categoryLabel(c.category),
                    count: c.ok_count,
                  })}
                  {c.skipped_count
                    ? `, ${t('common:migration.categorySkipped', { count: c.skipped_count })}`
                    : ''}
                  {c.failed_count
                    ? `, ${t('common:migration.categoryFailed', { count: c.failed_count })}`
                    : ''}
                </li>
              ))}
            </ul>
            {result.backup_path && (
              <div className="text-xs text-muted-foreground">
                {withPath(
                  t('common:migration.backupKept', {
                    path: result.backup_path,
                  }),
                  result.backup_path
                )}
              </div>
            )}
            {result.restart_required && (
              <div className="text-xs text-muted-foreground">
                {t('common:migration.restartNeeded')}
              </div>
            )}
            {result.reuse_path && (
              <div className="text-xs text-muted-foreground">
                {withPath(
                  t('common:migration.reuseInPlace', {
                    path: result.reuse_path,
                  }),
                  result.reuse_path
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="font-medium text-destructive">
              {t('common:migration.failed')}
            </div>
            <div className="text-xs text-muted-foreground">
              {result?.error || error || t('common:migration.unknownError')}
              {result?.rolled_back || rolledBack
                ? ` ${t('common:migration.rolledBackNote')}`
                : ''}
            </div>
            {result?.quarantine_dir && (
              <div className="text-xs text-muted-foreground">
                {withPath(
                  t('common:migration.quarantined', {
                    path: result.quarantine_dir,
                  }),
                  result.quarantine_dir
                )}
              </div>
            )}
          </>
        )}
      </div>
  )
}
