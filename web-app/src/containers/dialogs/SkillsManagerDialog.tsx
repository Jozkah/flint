import { useState } from 'react'
import { toast } from 'sonner'
import { Plus, Trash2, FileText, DownloadCloud, Loader2, Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import {
  useSkills,
  effectiveEnabled,
  type HubSkill,
} from '@/hooks/useSkills'
import { normalizeAppError } from '@/utils/appError'

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

  const { skills, enabled, remove, write, read, hubList, hubImport } =
    useSkills(folder)
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

  const editing = isNew || selected !== null

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
          <div className="flex gap-4 h-[60vh] overflow-hidden">
            {/* Skill list */}
            <div className="w-1/3 min-h-0 flex flex-col gap-2 border-r pr-3">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 justify-start"
                onClick={startNew}
              >
                <Plus size={14} />
                {t('common:skillNew')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'gap-1.5 justify-start',
                  hubMode && 'bg-accent'
                )}
                onClick={openHub}
              >
                <DownloadCloud size={14} />
                {t('common:skillHubImport')}
              </Button>
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
                    <div
                      key={s.name}
                      role="button"
                      tabIndex={0}
                      className={cn(
                        'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        !hubMode && selected === s.name && 'bg-accent'
                      )}
                      onClick={() => openSkill(s.name)}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          openSkill(s.name)
                        }
                      }}
                    >
                      <FileText size={14} className="shrink-0 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <div className="truncate font-medium">{s.name}</div>
                        {s.description && (
                          <div className="line-clamp-2 break-words text-xs text-muted-foreground">
                            {s.description}
                          </div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {enabledNames.has(s.name)
                            ? t('connections:skills.state.enabled')
                            : t('connections:skills.state.disabled')}
                        </div>
                      </div>
                      <button
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete(s.name)
                        }}
                        title={t('common:skillDelete')}
                        aria-label={t('connections:skills.deleteSkill', {
                          name: s.name,
                        })}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Right pane: hub browser, editor, or placeholder */}
            <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-2">
              {hubMode ? (
                <>
                  <div className="text-sm font-medium">
                    {t('common:skillHubTitle')}
                  </div>
                  {importError && (
                    <p role="alert" className="text-xs text-destructive break-words">
                      {t('connections:skills.importFailed', {
                        name: importError.name,
                        error: importError.message,
                      })}
                    </p>
                  )}
                  {hubLoading ? (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                      <Loader2 className="animate-spin" size={18} />
                    </div>
                  ) : hubError ? (
                    <p role="alert" className="text-sm text-destructive break-words">
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
                              className="gap-1 shrink-0"
                              disabled={importing !== null}
                              onClick={() => handleImport(s.name)}
                            >
                              {importing === s.name ? (
                                <Loader2 className="animate-spin" size={12} />
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
                  <Textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={t('common:skillContentPlaceholder')}
                    className="flex-1 font-mono text-xs resize-none"
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={closeEditor}>
                      {t('common:cancel')}
                    </Button>
                    <Button size="sm" onClick={handleSave} disabled={saving}>
                      {t('common:skillSave')}
                    </Button>
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
