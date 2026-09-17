import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Trash2, FileText, Loader2, Folder } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  storeScope,
  projectScope,
  isPluginSkill,
  listSkills,
  readSkill,
  writeSkill,
  deleteSkill,
  type SkillMeta,
  type SkillScope,
} from '@/lib/skillStore'
import { listProjects, type ProjectEntry } from '@/lib/extensionsStore'
import EnablementGrid from '@/containers/extensions/EnablementGrid'

/**
 * A skills group is either the global store or one registered project.
 * Every group shares the same key namespace ('global' plus each project's
 * `id`) so the editor's `openTarget` can address a skill unambiguously.
 */
type GroupKey = 'global' | string

/**
 * Skills view for the `/extensions` route's Skills tab: a "Global" group
 * (the desktop's permanent skill store, full CRUD -- the same store
 * `SkillsManagerDialog` edits) plus one read-oriented group per registered
 * project, so a project's local skills are visible without leaving the
 * page. Project skills open in the same editor on click; saving there
 * writes back into that project's `.jan/agent/skills`.
 */
export default function SkillsTab() {
  const { t } = useTranslation()

  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [globalSkills, setGlobalSkills] = useState<SkillMeta[]>([])
  const [projectSkills, setProjectSkills] = useState<
    Record<string, SkillMeta[]>
  >({})
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [projectList, global] = await Promise.all([
        listProjects(),
        listSkills(storeScope),
      ])
      setProjects(projectList)
      setGlobalSkills(global)
      const perProject = await Promise.all(
        projectList.map((p) =>
          listSkills(projectScope(p.folder)).catch(() => [] as SkillMeta[])
        )
      )
      setProjectSkills(
        Object.fromEntries(projectList.map((p, i) => [p.id, perProject[i]]))
      )
    } catch (e) {
      toast.error(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Editor state: which (group, skill) is open, or a fresh draft.
  const [openGroup, setOpenGroup] = useState<GroupKey | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)

  const scopeFor = (group: GroupKey): SkillScope =>
    group === 'global'
      ? storeScope
      : projectScope(projects.find((p) => p.id === group)?.folder ?? '')

  const closeEditor = () => {
    setOpenGroup(null)
    setSelected(null)
    setIsNew(false)
    setName('')
    setContent('')
  }

  const openSkill = async (group: GroupKey, skillName: string) => {
    try {
      const body = await readSkill(scopeFor(group), skillName)
      setOpenGroup(group)
      setSelected(skillName)
      setIsNew(false)
      setName(skillName)
      setContent(body)
    } catch (e) {
      toast.error(String(e))
    }
  }

  const startNew = () => {
    setOpenGroup('global')
    setSelected(null)
    setIsNew(true)
    setName('')
    setContent('---\nname: \ndescription: \n---\n\n')
  }

  const handleSave = async () => {
    const trimmed = name.trim()
    if (!trimmed || !openGroup) {
      toast.error(t('common:skillNameRequired'))
      return
    }
    setSaving(true)
    try {
      await writeSkill(scopeFor(openGroup), trimmed, content)
      setSelected(trimmed)
      setIsNew(false)
      toast.success(t('common:skillSaved'))
      await refresh()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (group: GroupKey, skillName: string) => {
    try {
      await deleteSkill(scopeFor(group), skillName)
      if (openGroup === group && selected === skillName) closeEditor()
      await refresh()
    } catch (e) {
      toast.error(String(e))
    }
  }

  const editing = isNew || selected !== null

  // The matrix id rule from `resolve_extensions`: a plugin skill is keyed by
  // its plugin id, a standalone skill by its own name. Only global-store
  // skills have matrix entries (project skills always resolve enabled), so
  // the grid only applies when editing a global one.
  const selectedGlobalMeta =
    openGroup === 'global' && selected !== null
      ? globalSkills.find((s) => s.name === selected)
      : undefined
  const enablementTarget = selectedGlobalMeta
    ? isPluginSkill(selectedGlobalMeta)
      ? { kind: 'plugin' as const, id: selectedGlobalMeta.plugin as string }
      : { kind: 'skill' as const, id: selectedGlobalMeta.name }
    : null

  const renderSkillRow = (
    group: GroupKey,
    s: SkillMeta,
    { editable }: { editable: boolean }
  ) => (
    <div
      key={`${group}:${s.name}`}
      role="button"
      tabIndex={0}
      aria-current={openGroup === group && selected === s.name ? 'true' : undefined}
      className={cn(
        'group relative flex min-h-9 items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer text-ink-2 hover:bg-sunken hover:text-foreground outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring',
        openGroup === group &&
          selected === s.name &&
          'bg-accent text-foreground before:absolute before:left-0 before:inset-y-2 before:w-0.5 before:rounded-full before:bg-brand-rail'
      )}
      onClick={() => openSkill(group, s.name)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openSkill(group, s.name)
        }
      }}
    >
      <FileText size={14} className="shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="truncate font-medium text-foreground">{s.name}</div>
        {s.description && (
          <div className="line-clamp-2 break-words text-xs text-muted-foreground">
            {s.description}
          </div>
        )}
      </div>
      {editable && !isPluginSkill(s) && (
        <button
          type="button"
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-destructive-tint hover:text-destructive focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100 pointer-fine:group-focus-within:opacity-100 pointer-coarse:size-11"
          onClick={(e) => {
            e.stopPropagation()
            void handleDelete(group, s.name)
          }}
          title={t('common:skillDelete')}
        >
          <Trash2 size={14} aria-hidden />
        </button>
      )}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 sm:h-full sm:flex-row sm:gap-4 sm:overflow-hidden">
      <div className="flex max-h-[60vh] min-h-0 flex-col gap-4 overflow-y-auto border-b border-border pb-3 sm:max-h-none sm:w-1/3 sm:border-r sm:border-b-0 sm:pr-3 sm:pb-0">
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase text-muted-foreground">
              {t('common:extensions.global')}
            </div>
            <Button
              variant="outline"
              size="xs"
              className="gap-1 pointer-coarse:h-11"
              onClick={startNew}
            >
              <Plus size={12} aria-hidden />
              {t('common:skillNew')}
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            {globalSkills.length === 0 ? (
              <p className="text-xs text-muted-foreground px-1 py-2">
                {t('common:skillsEmpty')}
              </p>
            ) : (
              globalSkills.map((s) =>
                renderSkillRow('global', s, { editable: true })
              )
            )}
          </div>
        </div>

        {projects.map((p) => (
          <div key={p.id}>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
              <Folder size={12} aria-hidden />
              {p.name || p.folder}
            </div>
            <div className="flex flex-col gap-1">
              {(projectSkills[p.id] ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground px-1 py-2">
                  {t('common:skillsEmpty')}
                </p>
              ) : (
                (projectSkills[p.id] ?? []).map((s) =>
                  renderSkillRow(p.id, s, { editable: false })
                )
              )}
            </div>
          </div>
        ))}

        {loading && projects.length === 0 && globalSkills.length === 0 && (
          <div className="flex items-center justify-center py-6 text-ink-2">
            <Loader2 className="motion-safe:animate-spin" size={18} aria-hidden />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-2">
        {editing ? (
          <>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('common:skillNamePlaceholder')}
              disabled={!isNew}
            />
            {enablementTarget && (
              <div>
                <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                  {t('common:extensions.enablement.title', undefined) ?? 'Enabled on'}
                </div>
                <EnablementGrid kind={enablementTarget.kind} id={enablementTarget.id} />
              </div>
            )}
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t('common:skillContentPlaceholder')}
              className="min-h-48 flex-1 font-mono text-base md:text-xs resize-none"
              readOnly={openGroup !== 'global'}
              aria-readonly={openGroup !== 'global' ? true : undefined}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={closeEditor}>
                {t('common:cancel')}
              </Button>
              {openGroup === 'global' && (
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  {t('common:skillSave')}
                </Button>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            {t('common:skillsPickOrNew')}
          </div>
        )}
      </div>
    </div>
  )
}
