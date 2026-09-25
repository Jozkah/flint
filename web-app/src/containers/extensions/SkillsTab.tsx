import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import {
  FileText,
  Folder,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
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
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'

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

  const renderSkillCard = (
    group: GroupKey,
    s: SkillMeta,
    { editable }: { editable: boolean },
    index: number
  ) => {
    const current = openGroup === group && selected === s.name
    return (
      <Frame
        key={`${group}:${s.name}`}
        style={{ animationDelay: `${40 + index * 45}ms` }}
        className={cn(
          'group motion-safe:animate-rise-in',
          current &&
            'shadow-[inset_0_0_0_0.8px_var(--border),0_0_0_1.5px_var(--primary)]'
        )}
      >
        <FrameHeader
          icon={
            <span className="grid size-6 place-items-center rounded-[7px] bg-[rgba(139,92,246,.14)] text-[#7c3aed] dark:text-[#a78bfa]">
              <Sparkles className="size-3.5" aria-hidden />
            </span>
          }
          title={<span className="font-mono text-[13px]">{s.name}</span>}
          actions={
            editable && !isPluginSkill(s) ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-destructive pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100 pointer-coarse:size-11"
                onClick={() => void handleDelete(group, s.name)}
                title={t('common:skillDelete')}
                aria-label={`${t('common:skillDelete')}: ${s.name}`}
              >
                <Trash2 aria-hidden />
              </Button>
            ) : undefined
          }
        />
        <FrameBody className="gap-2.5 p-3">
          <p className="m-0 line-clamp-2 min-h-[2lh] text-[12.5px] leading-normal text-muted-foreground">
            {s.description || '—'}
          </p>
          <div className="flex items-center justify-between gap-2 text-xs text-subtle-foreground">
            <span className="min-w-0 truncate">
              {isPluginSkill(s)
                ? t('engine:extensions.fromPlugin', { name: s.plugin })
                : group === 'global'
                  ? t('engine:extensions.standaloneSkill')
                  : t('engine:extensions.projectSkill')}
            </span>
            <Button
              variant="surface"
              size="xs"
              aria-current={current ? 'true' : undefined}
              onClick={() => void openSkill(group, s.name)}
            >
              {editable
                ? t('engine:extensions.edit')
                : t('engine:extensions.view')}
            </Button>
          </div>
        </FrameBody>
      </Frame>
    )
  }

  const groupHeading = (label: ReactNode, action?: ReactNode) => (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-subtle-foreground uppercase">
        {label}
      </div>
      {action}
    </div>
  )

  const cardGrid = 'grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4'

  return (
    <div
      className={cn(
        'grid items-start gap-4',
        editing && 'lg:grid-cols-[minmax(0,1fr)_420px]'
      )}
    >
      <div className="flex min-w-0 flex-col gap-5">
        <section className="flex flex-col gap-3">
          {groupHeading(
            t('common:extensionsManager.global'),
            <Button size="sm" className="pointer-coarse:h-11" onClick={startNew}>
              <Plus aria-hidden />
              {t('common:skillNew')}
            </Button>
          )}
          {globalSkills.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              {t('common:skillsEmpty')}
            </p>
          ) : (
            <div className={cardGrid}>
              {globalSkills.map((s, i) =>
                renderSkillCard('global', s, { editable: true }, i)
              )}
            </div>
          )}
        </section>

        {projects.map((p) => (
          <section key={p.id} className="flex flex-col gap-3">
            {groupHeading(
              <>
                <Folder size={12} aria-hidden />
                {p.name || p.folder}
              </>
            )}
            {(projectSkills[p.id] ?? []).length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">
                {t('common:skillsEmpty')}
              </p>
            ) : (
              <div className={cardGrid}>
                {(projectSkills[p.id] ?? []).map((s, i) =>
                  renderSkillCard(p.id, s, { editable: false }, i)
                )}
              </div>
            )}
          </section>
        ))}

        {loading && projects.length === 0 && globalSkills.length === 0 && (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="motion-safe:animate-spin" size={18} aria-hidden />
          </div>
        )}
      </div>

      {editing && (
        <Frame className="motion-safe:animate-rise-in">
          <FrameHeader
            icon={<FileText />}
            title={isNew ? t('common:skillNew') : name}
            actions={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('engine:extensions.closePanel')}
                onClick={closeEditor}
              >
                <X aria-hidden />
              </Button>
            }
          />
          <FrameBody className="gap-3 p-3.5">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('common:skillNamePlaceholder')}
              disabled={!isNew}
            />
            {enablementTarget && (
              <div>
                <div className="mb-1.5 text-[11px] font-medium text-subtle-foreground uppercase">
                  {t('common:extensionsManager.enablement.title', undefined) ??
                    'Enabled on'}
                </div>
                <EnablementGrid
                  kind={enablementTarget.kind}
                  id={enablementTarget.id}
                />
              </div>
            )}
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t('common:skillContentPlaceholder')}
              className="min-h-64 resize-y font-mono text-base md:text-xs"
              readOnly={openGroup !== 'global'}
              aria-readonly={openGroup !== 'global' ? true : undefined}
            />
            <div className="flex justify-end gap-2">
              <Button variant="surface" size="sm" onClick={closeEditor}>
                {t('common:cancel')}
              </Button>
              {openGroup === 'global' && (
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  {t('common:skillSave')}
                </Button>
              )}
            </div>
          </FrameBody>
        </Frame>
      )}
    </div>
  )
}
