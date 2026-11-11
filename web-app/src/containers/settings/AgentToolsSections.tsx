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
import { AgentEntryRow } from '@/containers/settings/AgentEntryRow'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import type { SandboxStatus } from '@janhq/tauri-plugin-agent-tools-api'
import {
  useCoworkDisplay,
  type ReviewOnlyFinish,
} from '@/hooks/useCoworkDisplay'
import { Segmented } from '@/components/ui/segmented'
import { useCoworkParallel } from '@/hooks/useCoworkParallel'
import type { SkillMeta } from '@/lib/agentWorkspace'
import { SandboxToolchainGrants } from '@/containers/SandboxToolchainGrants'
import { CampaignParallelSetting } from '@/containers/CampaignSettings'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import type { ReactNode } from 'react'

/** An open skill editor. `original` is unset when creating, which is what
 * unlocks the name field: renaming an existing skill would mean a write plus a
 * delete. Agent notes (memory_write files) are edited on the Memory page. */
export type SkillEditorState = {
  original?: string
  name: string
  content: string
}

/** A long list scrolls inside its card instead of stretching the page. */
const LIST_CAP = 'max-h-[26rem] overflow-y-auto overscroll-contain pr-1 [scrollbar-width:thin]'

export function AgentEnableCard({
  path,
  onReveal,
}: {
  path: string
  onReveal: () => void
}) {
  const { t } = useTranslation()
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
  return (
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
          onClick={onReveal}
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
    </Card>
  )
}

export function CoworkRunsCard() {
  const { t } = useTranslation()
  const reviewOnlyFinish = useCoworkDisplay((x) => x.reviewOnlyFinish)
  const setReviewOnlyFinish = useCoworkDisplay((x) => x.setReviewOnlyFinish)
  const showFilesReadyBar = useCoworkDisplay((x) => x.showFilesReadyBar)
  const setShowFilesReadyBar = useCoworkDisplay((x) => x.setShowFilesReadyBar)
  const autoWorktree = useCoworkParallel((x) => x.autoWorktree)
  const setAutoWorktree = useCoworkParallel((x) => x.setAutoWorktree)
  const worktreeBase = useCoworkParallel((x) => x.worktreeBase)
  const setWorktreeBase = useCoworkParallel((x) => x.setWorktreeBase)
  return (
    <Card title={t('settings:agentTools.coworkRuns', { defaultValue: 'Cowork runs' })}>
      {/* What a finished Review only run does with its sandbox output.
          Only new files are ever applied without asking. */}
      <CardItem
        anchor="settings-agent-tools-review-only-finish"
        title={t('common:coworkReview.finishTitle')}
        description={t('common:coworkReview.finishDescription')}
        // Full width under the text: beside it the third option's
        // label had to wrap.
        column
        actions={
          <Segmented<ReviewOnlyFinish>
            size="sm"
            wrap
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
      <CardItem
        title={t('common:coworkParallel.baseTitle')}
        description={t('common:coworkParallel.baseDescription')}
        align="start"
        actions={
          <Switch
            data-testid="worktree-base-head"
            checked={worktreeBase === 'head'}
            onCheckedChange={(on) => setWorktreeBase(on ? 'head' : 'fresh')}
          />
        }
      />
      <CampaignParallelSetting />
    </Card>
  )
}

export function ShellSandboxCard({
  sandbox,
}: {
  sandbox: SandboxStatus | undefined
}) {
  const { t } = useTranslation()
  const agentToolsEnabled = useAgentToolsConfig((s) => s.agentToolsEnabled)
  const shellEnabled = useAgentToolsConfig((s) => s.shellEnabled)
  const setShellEnabled = useAgentToolsConfig((s) => s.setShellEnabled)
  const bashNetworkEnabled = useAgentToolsConfig((s) => s.bashNetworkEnabled)
  const setBashNetworkEnabled = useAgentToolsConfig(
    (s) => s.setBashNetworkEnabled
  )
  return (
    <Card
      title={t('settings:agentTools.shellSandboxTitle', { defaultValue: 'Shell and sandbox' })}
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
        actions={
          <Switch
            data-testid="shell-enabled-toggle"
            aria-label={t('settings:agentTools.shell')}
            checked={shellEnabled}
            onCheckedChange={setShellEnabled}
            disabled={!agentToolsEnabled}
          />
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
  )
}

export function SkillsCard({
  skills,
  ownSkills,
  pluginSkills,
  searchBox,
  addButton,
  openEditor,
  remove,
}: {
  skills: SkillMeta[]
  ownSkills: SkillMeta[]
  pluginSkills: SkillMeta[]
  searchBox: ReactNode
  addButton: ReactNode
  openEditor: (name?: string) => void | Promise<void>
  remove: (name: string) => void | Promise<void>
}) {
  const { t } = useTranslation()
  return (
    <Card
      title={t('settings:agentTools.skills')}
      description={t('settings:agentTools.skillsHelp')}
      aside={
        <div className="flex items-center gap-2">
          {skills.length > 6 && searchBox}
          {addButton}
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
          {ownSkills.map((skill) => (
            <AgentEntryRow
              key={`skill-${skill.name}`}
              name={skill.name}
              description={skill.description}
              warning={skill.warning}
              onEdit={() => openEditor(skill.name)}
              onDelete={() => remove(skill.name)}
            />
          ))}
          {pluginSkills.length > 0 && (
            <p className="px-1 pt-3 text-xs font-medium text-muted-foreground">
              {t('settings:agentTools.pluginSkills', { count: pluginSkills.length })}
            </p>
          )}
          {pluginSkills.map((skill) => (
            <AgentEntryRow
              key={`skill-${skill.name}`}
              name={skill.name}
              description={skill.description}
              warning={skill.warning}
              plugin={skill.plugin}
              onEdit={() => openEditor(skill.name)}
              onDelete={() => remove(skill.name)}
            />
          ))}
        </div>
      )}
    </Card>
  )
}

export function SkillEditorDialog({
  editor,
  setEditor,
  saving,
  save,
}: {
  editor: SkillEditorState | null
  setEditor: React.Dispatch<React.SetStateAction<SkillEditorState | null>>
  saving: boolean
  save: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  return (
  <Dialog
    open={editor !== null}
    onOpenChange={(open) => !open && setEditor(null)}
  >
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{t('settings:agentTools.editSkill')}</DialogTitle>
        <DialogDescription>
          {t('settings:agentTools.editSkillDesc')}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <Input
          type="text"
          aria-label={t('settings:agentTools.namePlaceholder')}
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
          aria-label={t('settings:agentTools.contentPlaceholder')}
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
  )
}
