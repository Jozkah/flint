import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { route } from '@/constants/routes'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Lock, LockOpen, Search } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import { useSettingsSearch } from '@/hooks/useSettingsSearch'
import { isPluginSkill } from '@/lib/skillStore'
import { Icon } from '@/components/ui/icon'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { getSandboxStatus } from '@/lib/agentTools'
import type { SandboxStatus } from '@janhq/tauri-plugin-agent-tools-api'
import {
  useCoworkDisplay,
  type ReviewOnlyFinish,
} from '@/hooks/useCoworkDisplay'
import { Segmented } from '@/components/ui/segmented'
import { useCoworkParallel } from '@/hooks/useCoworkParallel'
import {
  storePath,
  revealStore,
  listSkills,
  readSkill,
  writeSkill,
  deleteSkill,
  listMemories,
  readMemory,
  writeMemory,
  deleteMemory,
  type SkillMeta,
} from '@/lib/agentWorkspace'
import { errorText } from '@/lib/errorText'
import { CompactionPolicySettings } from '@/containers/CompactionPolicySettings'
import { AttributionSettings } from '@/containers/AttributionSettings'
import { ComputerExclusionSettings } from '@/containers/ComputerExclusionSettings'
import { SandboxToolchainGrants } from '@/containers/SandboxToolchainGrants'
import { BrowserAgentSettings } from '@/containers/BrowserAgentSettings'
import { SubagentSettings } from '@/containers/SubagentSettings'
import { VisualizeSettings } from '@/containers/VisualizeSettings'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.agent_tools as any)({
  component: AgentToolsContent,
})

type EntryKind = 'memory' | 'skill'

/** An open editor. `original` is unset when creating, which is what unlocks the
 * name field: renaming an existing entry would mean a write plus a delete. */
type Editor = {
  kind: EntryKind
  original?: string
  name: string
  content: string
}

/** Shared so a rejected Tauri command never renders as `[object Object]`. */
const messageOf = errorText

/** A long list scrolls inside its card instead of stretching the page. */
const LIST_CAP = 'max-h-[26rem] overflow-y-auto overscroll-contain pr-1 [scrollbar-width:thin]'

const SKILL_TEMPLATE = '---\ndescription: \n---\n\n'

function AgentToolsContent() {
  const { t } = useTranslation()
  const hideCompletedTools = useCoworkDisplay((x) => x.hideCompletedTools)
  const showPromptSnapshot = useCoworkDisplay((x) => x.showPromptSnapshot)
  const setShowPromptSnapshot = useCoworkDisplay(
    (x) => x.setShowPromptSnapshot
  )
  const reviewOnlyFinish = useCoworkDisplay((x) => x.reviewOnlyFinish)
  const setReviewOnlyFinish = useCoworkDisplay((x) => x.setReviewOnlyFinish)
  const showFilesReadyBar = useCoworkDisplay((x) => x.showFilesReadyBar)
  const setShowFilesReadyBar = useCoworkDisplay((x) => x.setShowFilesReadyBar)
  const autoWorktree = useCoworkParallel((x) => x.autoWorktree)
  const setAutoWorktree = useCoworkParallel((x) => x.setAutoWorktree)
  const setHideCompletedTools = useCoworkDisplay(
    (x) => x.setHideCompletedTools
  )
  const agentToolsEnabled = useAgentToolsConfig((s) => s.agentToolsEnabled)
  const setAgentToolsEnabled = useAgentToolsConfig(
    (s) => s.setAgentToolsEnabled
  )
  const chatDelegationEnabled = useAgentToolsConfig(
    (s) => s.chatDelegationEnabled
  )
  const setChatDelegationEnabled = useAgentToolsConfig(
    (s) => s.setChatDelegationEnabled
  )
  const bashNetworkEnabled = useAgentToolsConfig((s) => s.bashNetworkEnabled)
  const setBashNetworkEnabled = useAgentToolsConfig(
    (s) => s.setBashNetworkEnabled
  )
  // `undefined` until the probe answers, so the row reads as "checking" rather
  // than briefly claiming there is no sandbox.
  const [sandbox, setSandbox] = useState<SandboxStatus | undefined>()

  const [path, setPath] = useState('')
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [memories, setMemories] = useState<string[]>([])
  const [editor, setEditor] = useState<Editor | null>(null)
  const [saving, setSaving] = useState(false)
  // The page is long when there are many skills, so each kind of thing gets
  // its own tab and its own search instead of one scroll of everything.
  const [tab, setTab] = useState<'behaviour' | 'skills' | 'memories'>('behaviour')
  const [query, setQuery] = useState('')
  // Every searchable setting here lives on Behaviour; a search result opens it.
  const pendingTarget = useSettingsSearch((s) => s.pendingTarget)
  useEffect(() => {
    if (pendingTarget?.startsWith('settings-agent-tools')) setTab('behaviour')
  }, [pendingTarget])

  const refresh = useCallback(async () => {
    try {
      const [nextPath, nextSkills, nextMemories] = await Promise.all([
        storePath(),
        listSkills(),
        listMemories(),
      ])
      setPath(nextPath)
      setSkills(nextSkills)
      setMemories(nextMemories)
    } catch (e) {
      toast.error(t('settings:agentTools.loadFailed'), {
        description: messageOf(e),
      })
    }
  }, [t])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    getSandboxStatus().then(setSandbox)
  }, [])

  const openEditor = async (kind: EntryKind, name?: string) => {
    if (!name) {
      setEditor({
        kind,
        name: '',
        content: kind === 'skill' ? SKILL_TEMPLATE : '',
      })
      return
    }
    try {
      const content =
        kind === 'skill' ? await readSkill(name) : await readMemory(name)
      setEditor({ kind, original: name, name, content })
    } catch (e) {
      toast.error(t('settings:agentTools.loadFailed'), {
        description: messageOf(e),
      })
    }
  }

  const save = async () => {
    if (!editor) return
    const name = editor.name.trim()
    if (!name) return
    setSaving(true)
    try {
      if (editor.kind === 'skill') await writeSkill(name, editor.content)
      else await writeMemory(name, editor.content)
      setEditor(null)
      await refresh()
    } catch (e) {
      toast.error(t('settings:agentTools.saveFailed'), {
        description: messageOf(e),
      })
    } finally {
      setSaving(false)
    }
  }

  const remove = async (kind: EntryKind, name: string) => {
    try {
      if (kind === 'skill') await deleteSkill(name)
      else await deleteMemory(name)
      await refresh()
    } catch (e) {
      toast.error(t('settings:agentTools.deleteFailed'), {
        description: messageOf(e),
      })
    }
  }

  const reveal = async () => {
    try {
      await revealStore()
    } catch (e) {
      toast.error(t('settings:agentTools.revealFailed'), {
        description: messageOf(e),
      })
    }
  }

  const entryRow = (
    kind: EntryKind,
    name: string,
    description?: string,
    plugin?: string
  ) => (
    <CardItem
      key={`${kind}-${name}`}
      title={name}
      description={
        description ? (
          <span className="line-clamp-2 break-words">{description}</span>
        ) : undefined
      }
      actions={
        plugin ? (
          <Chip>{plugin}</Chip>
        ) : (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground pointer-coarse:size-11"
            title={t('common:edit')}
            aria-label={`${t('common:edit')} ${name}`}
            onClick={() => openEditor(kind, name)}
          >
            <Icon name="x-edit" size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive pointer-coarse:size-11"
            title={t('common:delete')}
            aria-label={`${t('common:delete')} ${name}`}
            onClick={() => remove(kind, name)}
          >
            <Icon name="x-trash" size={16} />
          </Button>
        </div>
        )
      }
    />
  )

  const q = query.trim().toLowerCase()
  const matches = (name: string, description?: string) =>
    !q ||
    name.toLowerCase().includes(q) ||
    (description ?? '').toLowerCase().includes(q)
  const ownSkills = skills.filter(
    (k) => !isPluginSkill(k) && matches(k.name, k.description)
  )
  const pluginSkills = skills.filter(
    (k) => isPluginSkill(k) && matches(k.name, k.description)
  )
  const shownMemories = memories.filter((m) => matches(m))
  const searchBox = (
    <div className="relative w-56 max-w-full">
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
        }}
        placeholder={t('settings:agentTools.search')}
        aria-label={t('settings:agentTools.search')}
        className="h-8 pl-8"
      />
    </div>
  )

  const addButton = (kind: EntryKind) => (
    <Button
      variant="outline"
      className="pointer-coarse:h-11"
      onClick={() => openEditor(kind)}
    >
      {t('settings:agentTools.add')}
    </Button>
  )

  return (
    <div className="flex flex-col h-full w-full">
      <SettingsPageHeader title={t('common:agent_tools')} />
      <SettingsPageBody
        title={t('common:agent_tools')}
        description={t('settings:pageDesc.agentTools')}
        // Behaviour: tools | shell, then compaction | browser. Skills and
        // memories are a lone group each and span the page.
        layout={[0, 1, 0, 1]}
        actions={
          <Segmented<'behaviour' | 'skills' | 'memories'>
            // Remounted when the counts arrive: the gliding pill is measured
            // once, and the labels grow after the lists load.
            key={`${skills.length}-${memories.length}`}
            size="sm"
            aria-label={t('common:agent_tools')}
            value={tab}
            onValueChange={(v) => {
              setTab(v)
              setQuery('')
                }}
            options={[
              { value: 'behaviour', label: t('settings:agentTools.tabBehaviour') },
              {
                value: 'skills',
                label: `${t('settings:agentTools.skills')} (${skills.length})`,
              },
              {
                value: 'memories',
                label: `${t('settings:agentTools.memories')} (${memories.length})`,
              },
            ]}
          />
        }
      >
        {tab === 'behaviour' && (
        <Card
          title={t('settings:agentTools.title')}
          description={t('settings:agentTools.description')}
          aside={
            // The path is a tooltip, not a row: it derives from the Flint data
            // folder that Settings > General already owns.
            <Button
              variant="outline"
              className="shrink-0 pointer-coarse:h-11"
              title={path}
              onClick={reveal}
              disabled={!path}
            >
              <Icon name="x-code" size={14} />
              {t('settings:agentTools.openFolder')}
            </Button>
          }
        >
          <CardItem
            anchor="settings-agent-tools-enable"
            title={t('settings:agentTools.enable')}
            description={t('settings:agentTools.enableDesc')}
            align="start"
            actions={
              <Switch
                checked={agentToolsEnabled}
                onCheckedChange={setAgentToolsEnabled}
              />
            }
          />
          {/* Chats may hand jobs to subagents. Each child's changes and
              commands still ask, exactly as the chat's own do. */}
          <CardItem
            anchor="settings-agent-tools-chat-delegation"
            title={t('settings:agentTools.chatDelegation')}
            description={t('settings:agentTools.chatDelegationDesc')}
            align="start"
            actions={
              <Switch
                data-testid="chat-delegation-toggle"
                checked={chatDelegationEnabled}
                onCheckedChange={setChatDelegationEnabled}
                disabled={!agentToolsEnabled}
              />
            }
          />
          {/* A display preference, kept beside the tools it is about.
              Nothing is deleted: hidden activity stays in the session, in
              exports and in search. */}
          <CardItem
            anchor="settings-agent-tools-hide-completed"
            title={t('common:coworkDisplay.hideCompletedTools')}
            description={t('common:coworkDisplay.hideCompletedToolsDescription')}
            align="start"
            actions={
              <Switch
                data-testid="hide-completed-tools"
                checked={hideCompletedTools}
                onCheckedChange={setHideCompletedTools}
              />
            }
          />
          {/* The per-turn record of the request; still recorded when off,
              and reachable from the session's details and timeline. */}
          <CardItem
            anchor="settings-agent-tools-model-received"
            title={t('common:coworkDisplay.showModelReceived')}
            description={t('common:coworkDisplay.showModelReceivedDescription')}
            align="start"
            actions={
              <Switch
                data-testid="show-model-received"
                checked={showPromptSnapshot}
                onCheckedChange={setShowPromptSnapshot}
              />
            }
          />
          {/* What a finished Review only run does with its sandbox output.
              Only new files are ever applied without asking. */}
          <CardItem
            anchor="settings-agent-tools-review-only-finish"
            title={t('common:coworkReview.finishTitle')}
            description={t('common:coworkReview.finishDescription')}
            align="start"
            actions={
              <Segmented<ReviewOnlyFinish>
                size="sm"
                aria-label={t('common:coworkReview.finishTitle')}
                value={reviewOnlyFinish}
                onValueChange={setReviewOnlyFinish}
                options={(['keep', 'ask', 'auto'] as const).map((value) => ({
                  value,
                  label: t(`common:coworkReview.finish.${value}`),
                  testId: `review-only-finish-${value}`,
                }))}
              />
            }
          />
          <CardItem
            title={t('common:coworkReview.showBarTitle')}
            description={t('common:coworkReview.showBarDescription')}
            align="start"
            actions={
              <Switch
                data-testid="show-files-ready-bar"
                checked={showFilesReadyBar}
                onCheckedChange={setShowFilesReadyBar}
              />
            }
          />
          {/* Parallel sessions on one folder: each new session in a Git
              folder gets its own worktree and branch unless this is off. */}
          <CardItem
            title={t('common:coworkParallel.settingTitle')}
            description={t('common:coworkParallel.settingDescription')}
            align="start"
            actions={
              <Switch
                data-testid="auto-worktree"
                checked={autoWorktree}
                onCheckedChange={setAutoWorktree}
              />
            }
          />
        </Card>
        )}

        {tab === 'behaviour' && (
        <Card
          title={t('settings:agentTools.shellTitle')}
          description={t('settings:agentTools.shellDescription')}
        >
          <CardItem
            title={t('settings:agentTools.shell')}
            align="start"
            description={
              <span className="flex items-start gap-1.5">
                {sandbox?.enforces ? (
                  <Lock className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
                ) : (
                  <LockOpen
                    className="mt-0.5 size-3.5 shrink-0 text-destructive"
                    aria-hidden
                  />
                )}
                <span>
                  {sandbox === undefined
                    ? t('settings:agentTools.shellChecking')
                    : sandbox.enforces
                      ? t('settings:agentTools.shellSandboxed', {
                          backend: sandbox.backend,
                        })
                      : t('settings:agentTools.shellUnavailable')}
                </span>
              </span>
            }
          />
          {/* Only offered where it can be enforced: with no backend there is
              no shell to give network access to in the first place. */}
          {sandbox?.enforces && (
            <CardItem
              anchor="settings-agent-tools-network"
              title={t('settings:agentTools.network')}
              description={t('settings:agentTools.networkDesc')}
              align="start"
              actions={
                <Switch
                  checked={bashNetworkEnabled}
                  onCheckedChange={setBashNetworkEnabled}
                  disabled={!agentToolsEnabled}
                />
              }
            />
          )}
          {sandbox?.enforces && <SandboxToolchainGrants />}
          <AttributionSettings />
          <ComputerExclusionSettings />
        </Card>
        )}

        {tab === 'behaviour' && <SubagentSettings />}
        {tab === 'behaviour' && <CompactionPolicySettings />}
        {tab === 'behaviour' && <BrowserAgentSettings />}
        {tab === 'behaviour' && <VisualizeSettings />}
        {tab === 'memories' && (
          <Card
            title={t('settings:agentTools.memories')}
            aside={
              <div className="flex items-center gap-2">
                {memories.length > 6 && searchBox}
                {addButton('memory')}
              </div>
            }
          >
            {memories.length === 0 ? (
              <CardItem description={t('settings:agentTools.noMemories')} />
            ) : shownMemories.length === 0 ? (
              <CardItem description={t('settings:agentTools.noMatches')} />
            ) : (
              <div className={LIST_CAP}>
                {shownMemories.map((name) => entryRow('memory', name))}
              </div>
            )}
          </Card>
        )}

        {tab === 'skills' && (
          <Card
            title={t('settings:agentTools.skills')}
            description={t('settings:agentTools.skillsHelp')}
            aside={
              <div className="flex items-center gap-2">
                {skills.length > 6 && searchBox}
                {addButton('skill')}
              </div>
            }
          >
            {skills.length === 0 ? (
              <CardItem description={t('settings:agentTools.noSkills')} />
            ) : ownSkills.length + pluginSkills.length === 0 ? (
              <CardItem description={t('settings:agentTools.noMatches')} />
            ) : (
              <div className={LIST_CAP}>
                {ownSkills.length > 0 && pluginSkills.length > 0 && (
                  <p className="px-1 pt-1 text-xs font-medium text-muted-foreground">
                    {t('settings:agentTools.yourSkills', { count: ownSkills.length })}
                  </p>
                )}
                {ownSkills.map((skill) =>
                  entryRow('skill', skill.name, skill.description)
                )}
                {pluginSkills.length > 0 && (
                  <p className="px-1 pt-3 text-xs font-medium text-muted-foreground">
                    {t('settings:agentTools.pluginSkills', { count: pluginSkills.length })}
                  </p>
                )}
                {pluginSkills.map((skill) =>
                  entryRow('skill', skill.name, skill.description, skill.plugin)
                )}
              </div>
            )}
          </Card>
        )}
      </SettingsPageBody>

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => !open && setEditor(null)}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t(
                editor?.kind === 'skill'
                  ? 'settings:agentTools.editSkill'
                  : 'settings:agentTools.editMemory'
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                editor?.kind === 'skill'
                  ? 'settings:agentTools.editSkillDesc'
                  : 'settings:agentTools.editMemoryDesc'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              type="text"
              placeholder={t('settings:agentTools.namePlaceholder')}
              value={editor?.name ?? ''}
              // Locked once the entry exists: a new name would create a second
              // entry rather than rename this one.
              disabled={editor?.original !== undefined}
              onChange={(e) =>
                setEditor((prev) =>
                  prev ? { ...prev, name: e.target.value } : prev
                )
              }
            />
            <Textarea
              className="min-h-64 font-mono text-base md:text-xs"
              placeholder={t('settings:agentTools.contentPlaceholder')}
              value={editor?.content ?? ''}
              onChange={(e) =>
                setEditor((prev) =>
                  prev ? { ...prev, content: e.target.value } : prev
                )
              }
            />
          </div>
          <DialogFooter className={STICKY_DIALOG_FOOTER}>
            <Button
              variant="ghost"
              className="pointer-coarse:h-11"
              onClick={() => setEditor(null)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              className="pointer-coarse:h-11"
              onClick={save}
              disabled={saving || !editor?.name.trim()}
            >
              {t('common:save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
