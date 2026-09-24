import { useState } from 'react'
import { toast } from 'sonner'
import {
  Check,
  DownloadCloud,
  Eye,
  EyeOff,
  FileText,
  Globe,
  Loader2,
  OctagonAlert,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useGlobalExtensions, type Scope } from '@/hooks/useGlobalExtensions'
import {
  useSkills,
  effectiveEnabled,
  type HubSkill,
} from '@/hooks/useSkills'
import { normalizeAppError } from '@/utils/appError'
import { isPluginSkill } from '@/lib/skillStore'

function SkillListRow({
  skill: s,
  isSelected,
  isEnabled,
  isPlugin,
  scope,
  onSelect,
  onToggleEnabled,
  onScopeChange,
  onDelete,
  t,
}: {
  skill: { name: string; description?: string; plugin?: string }
  isSelected: boolean
  isEnabled: boolean
  isPlugin: boolean
  scope: Scope
  onSelect: () => void
  onToggleEnabled: () => void
  onScopeChange: (scope: Scope) => void
  onDelete: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  const openRowMenu = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenuOpen(true)
  }

  const onRowKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      openRowMenu(e)
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect()
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={isSelected ? 'true' : undefined}
      className={cn(
        'group relative flex min-h-9 items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer text-ink-2 hover:bg-sunken hover:text-foreground outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring',
        isSelected &&
          'bg-accent text-foreground before:absolute before:left-0 before:inset-y-2 before:w-0.5 before:rounded-full before:bg-brand-rail'
      )}
      onClick={onSelect}
      onContextMenu={openRowMenu}
      onKeyDown={onRowKeyDown}
    >
      <FileText size={14} className="shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="truncate font-medium text-foreground">{s.name}</div>
        {isPlugin && s.plugin && (
          <div className="truncate text-xs text-muted-foreground">
            {t('connections:skills.fromPlugin', { plugin: s.plugin })}
          </div>
        )}
        {s.description && (
          <div className="line-clamp-2 break-words text-xs text-muted-foreground">
            {s.description}
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          <span>
            {isEnabled
              ? t('connections:skills.state.enabled')
              : t('connections:skills.state.disabled')}
          </span>
          {' · '}
          {scope === 'global' ? 'Global' : 'Workspace'}
        </div>
      </div>
      {!isPlugin && (
        <button
          type="button"
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-destructive-tint hover:text-destructive focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100 pointer-fine:group-focus-within:opacity-100 pointer-coarse:size-11"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title={t('common:skillDelete')}
          aria-label={t('connections:skills.deleteSkill', { name: s.name })}
        >
          <Trash2 size={14} aria-hidden />
        </button>
      )}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger className="sr-only" />
        <DropdownMenuContent className="w-48" align="start">
          <DropdownMenuItem onSelect={onSelect}>
            <Pencil size={14} />
            <span>{isPlugin ? t('connections:skills.view') : t('connections:skills.edit')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onToggleEnabled}>
            {isEnabled ? <EyeOff size={14} /> : <Eye size={14} />}
            <span>
              {isEnabled
                ? t('connections:skills.state.disable')
                : t('connections:skills.state.enable')}
            </span>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Globe size={14} />
              <span>Scope</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => onScopeChange('workspace')}>
                {scope === 'workspace' && <Check size={14} />}
                <span>Workspace only</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onScopeChange('global')}>
                {scope === 'global' && <Check size={14} />}
                <span>Global (all workspaces)</span>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {!isPlugin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={onDelete}
              >
                <Trash2 size={14} />
                <span>{t('common:skillDelete')}</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export default function SkillsManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const sessions = useCoworkSessions((s) => s.sessions)
  const currentId = useCoworkSessions((s) => s.currentId)
  const folder = sessions.find((s) => s.id === currentId)?.folder ?? null

  const { skills, enabled, setEnabled, remove, write, read, hubList, hubImport } =
    useSkills(folder)
  const globalExt = useGlobalExtensions()
  const localNames = new Set(skills.map((s) => s.name))
  // Installed = listed here. Enabled = in the project's `[skills].enabled`
  // whitelist (empty whitelist = all), which is what the agent is offered.
  const enabledNames = effectiveEnabled(
    enabled,
    skills.map((s) => s.name)
  )

  // `selected` is the skill being edited; '' with isNew means a fresh draft.
  const [selected, setSelected] = useState<string | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)

  // Hub browse state.
  const [hubMode, setHubMode] = useState(false)
  const [hubSkills, setHubSkills] = useState<HubSkill[]>([])
  const [hubLoading, setHubLoading] = useState(false)
  const [importing, setImporting] = useState<string | null>(null)
  /** Inline hub errors: shown next to what failed, not only as a toast. */
  const [hubError, setHubError] = useState<string | null>(null)
  const [importError, setImportError] = useState<{
    name: string
    message: string
  } | null>(null)

  const openSkill = async (skillName: string) => {
    try {
      const body = await read(skillName)
      setHubMode(false)
      setSelected(skillName)
      setIsNew(false)
      setName(skillName)
      setContent(body)
    } catch (e) {
      toast.error(String(e))
    }
  }

  const startNew = () => {
    setHubMode(false)
    setSelected(null)
    setIsNew(true)
    setName('')
    // Prefill the SKILL.md frontmatter so new (folder-form) skills carry a
    // name/description the catalog can read.
    setContent('---\nname: \ndescription: \n---\n\n')
  }

  const closeEditor = () => {
    setSelected(null)
    setIsNew(false)
    setName('')
    setContent('')
  }

  const openHub = async () => {
    closeEditor()
    setHubMode(true)
    if (hubSkills.length === 0) {
      setHubLoading(true)
      setHubError(null)
      try {
        setHubSkills(await hubList())
      } catch (e) {
        setHubError(normalizeAppError(e))
      } finally {
        setHubLoading(false)
      }
    }
  }

  const handleImport = async (skillName: string) => {
    setImporting(skillName)
    setImportError(null)
    try {
      // Success is announced only once the backend has finished the import.
      await hubImport(skillName)
      toast.success(t('common:skillImported', { name: skillName }))
    } catch (e) {
      setImportError({ name: skillName, message: normalizeAppError(e) })
    } finally {
      setImporting(null)
    }
  }

  const handleSave = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error(t('common:skillNameRequired'))
      return
    }
    setSaving(true)
    try {
      await write(trimmed, content)
      setSelected(trimmed)
      setIsNew(false)
      toast.success(t('common:skillSaved'))
    } catch (e) {
      toast.error(String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (skillName: string) => {
    try {
      await remove(skillName)
      if (selected === skillName) closeEditor()
    } catch (e) {
      toast.error(String(e))
    }
  }

  const toggleSkillEnabled = (skillName: string) => {
    const allNames = skills.map((s) => s.name)
    const current = effectiveEnabled(enabled, allNames)
    if (current.has(skillName)) {
      void setEnabled(enabled.filter((n) => n !== skillName))
    } else {
      void setEnabled([...enabled, skillName])
    }
  }

  const editing = isNew || selected !== null
  // A plugin's skill is shown, never saved: the backend refuses writes to it,
  // and the place to change it is the plugin's own source.
  const selectedMeta = selected ? skills.find((s) => s.name === selected) : undefined
  const readOnlyPlugin =
    !isNew && selectedMeta && isPluginSkill(selectedMeta)
      ? (selectedMeta.plugin ?? null)
      : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('common:skillsTitle')}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-1 text-xs">
              <p>{t('connections:skills.whatIs')}</p>
              {folder && <p>{t('connections:skills.whereApplies')}</p>}
              <p>{t('connections:skills.toolAccess')}</p>
            </div>
          </DialogDescription>
        </DialogHeader>

        {!folder ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {t('common:skillsSelectFolder')}
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-3 sm:h-[60vh] sm:flex-row sm:gap-4 sm:overflow-hidden">
            {/* Skill list */}
            <div className="flex max-h-[40vh] min-h-0 flex-col gap-2 border-b border-border pb-3 sm:max-h-none sm:w-1/3 sm:border-r sm:border-b-0 sm:pr-3 sm:pb-0">
              <div className="flex flex-wrap gap-2 sm:flex-col">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 justify-start pointer-coarse:h-11"
                  onClick={startNew}
                >
                  <Plus size={14} aria-hidden />
                  {t('common:skillNew')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={hubMode}
                  className={cn(
                    'gap-1.5 justify-start pointer-coarse:h-11',
                    hubMode && 'bg-accent text-foreground'
                  )}
                  onClick={openHub}
                >
                  <DownloadCloud size={14} aria-hidden />
                  {t('common:skillHubImport')}
                </Button>
              </div>
              {skills.length > 0 && (
                <div className="px-1 text-xs text-muted-foreground">
                  <p>
                    {t('connections:skills.summary', {
                      enabled: enabledNames.size,
                      installed: skills.length,
                    })}
                  </p>
                  <p>{t('connections:skills.stateHelp')}</p>
                </div>
              )}
              <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1">
                {skills.length === 0 ? (
                  <p className="text-xs text-muted-foreground px-1 py-2">
                    {t('common:skillsEmpty')}
                  </p>
                ) : (
                  skills.map((s) => (
                    <SkillListRow
                      key={s.name}
                      skill={s}
                      isSelected={!hubMode && selected === s.name}
                      isEnabled={enabledNames.has(s.name)}
                      isPlugin={isPluginSkill(s)}
                      scope={globalExt.getSkillScope(s.name)}
                      onSelect={() => openSkill(s.name)}
                      onToggleEnabled={() => toggleSkillEnabled(s.name)}
                      onScopeChange={(sc) => globalExt.setSkillScope(s.name, sc)}
                      onDelete={() => handleDelete(s.name)}
                      t={t}
                    />
                  ))
                )}
              </div>
            </div>

            {/* Right pane: hub browser, editor, or placeholder */}
            <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-2">
              {hubMode ? (
                <>
                  <div className="text-[13px] font-semibold text-foreground">
                    {t('common:skillHubTitle')}
                  </div>
                  {importError && (
                    <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive break-words">
                      <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                      {t('connections:skills.importFailed', {
                        name: importError.name,
                        error: importError.message,
                      })}
                    </p>
                  )}
                  {hubLoading ? (
                    <div className="flex-1 flex items-center justify-center py-6 text-ink-2">
                      <Loader2 className="motion-safe:animate-spin" size={18} aria-hidden />
                    </div>
                  ) : hubError ? (
                    <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive break-words">
                      <OctagonAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                      {t('connections:skills.loadHubFailed', { error: hubError })}
                    </p>
                  ) : hubSkills.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                      {t('common:skillHubEmpty')}
                    </div>
                  ) : (
                    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1">
                      {hubSkills.map((s) => {
                        const imported = localNames.has(s.name)
                        return (
                          <div
                            key={s.name}
                            className="flex items-center gap-2 rounded-md px-2 py-1.5 min-w-0"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="truncate font-medium text-sm">
                                {s.name}
                              </div>
                              {s.description && (
                                <div className="line-clamp-2 break-words text-xs text-muted-foreground">
                                  {s.description}
                                </div>
                              )}
                            </div>
                            <Button
                              variant="outline"
                              size="xs"
                              className="gap-1 shrink-0 pointer-coarse:h-11"
                              disabled={importing !== null}
                              onClick={() => handleImport(s.name)}
                            >
                              {importing === s.name ? (
                                <Loader2 className="motion-safe:animate-spin" size={12} aria-hidden />
                              ) : imported ? (
                                <Check size={12} />
                              ) : (
                                <DownloadCloud size={12} />
                              )}
                              {imported
                                ? t('common:skillReimport')
                                : t('common:skillImport')}
                            </Button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </>
              ) : editing ? (
                <>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('common:skillNamePlaceholder')}
                    disabled={!isNew}
                  />
                  {readOnlyPlugin && (
                    <p role="note" className="text-xs text-muted-foreground break-words">
                      {t('connections:skills.pluginReadOnly', {
                        plugin: readOnlyPlugin,
                      })}
                    </p>
                  )}
                  <Textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={t('common:skillContentPlaceholder')}
                    className="min-h-48 flex-1 font-mono text-base md:text-xs resize-none"
                    readOnly={readOnlyPlugin !== null}
                    aria-readonly={readOnlyPlugin !== null ? true : undefined}
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={closeEditor}>
                      {t('common:cancel')}
                    </Button>
                    {readOnlyPlugin === null && (
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
        )}
      </DialogContent>
    </Dialog>
  )
}
