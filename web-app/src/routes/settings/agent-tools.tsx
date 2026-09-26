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
import { Lock, LockOpen } from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { getSandboxStatus } from '@/lib/agentTools'
import type { SandboxStatus } from '@janhq/tauri-plugin-agent-tools-api'
import { useCoworkDisplay } from '@/hooks/useCoworkDisplay'
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
import { SandboxToolchainGrants } from '@/containers/SandboxToolchainGrants'
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

const SKILL_TEMPLATE = '---\ndescription: \n---\n\n'

function AgentToolsContent() {
  const { t } = useTranslation()
  const hideCompletedTools = useCoworkDisplay((x) => x.hideCompletedTools)
  const autoWorktree = useCoworkParallel((x) => x.autoWorktree)
  const setAutoWorktree = useCoworkParallel((x) => x.setAutoWorktree)
  const setHideCompletedTools = useCoworkDisplay(
    (x) => x.setHideCompletedTools
  )
  const agentToolsEnabled = useAgentToolsConfig((s) => s.agentToolsEnabled)
  const setAgentToolsEnabled = useAgentToolsConfig(
    (s) => s.setAgentToolsEnabled
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
    description?: string
  ) => (
    <CardItem
      key={`${kind}-${name}`}
      title={name}
      description={description}
      actions={
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
      }
    />
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
        layout={[0, 1, 0, 1]}
      >
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
        </Card>

        <CompactionPolicySettings />
        <Card
          title={t('settings:agentTools.memories')}
          aside={addButton('memory')}
        >
          {memories.length === 0 ? (
            <CardItem
              description={t('settings:agentTools.noMemories')}
            />
          ) : (
            memories.map((name) => entryRow('memory', name))
          )}
        </Card>

        <Card title={t('settings:agentTools.skills')} aside={addButton('skill')}>
          {skills.length === 0 ? (
            <CardItem description={t('settings:agentTools.noSkills')} />
          ) : (
            skills.map((skill) =>
              entryRow('skill', skill.name, skill.description)
            )
          )}
        </Card>
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
