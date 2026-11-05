import { isPlatformTauri } from '@/lib/platform/utils'
import { isServedByFlint } from '@/lib/platform/utils'
import { DesktopOnlyPage } from '@/containers/DesktopOnlyPage'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { route } from '@/constants/routes'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Search } from 'lucide-react'
import { entryMatches } from '@/containers/settings/AgentEntryRow'
import {
  SettingsTabStrip,
  useSettingsTab,
  type SettingsTab,
} from '@/containers/SettingsTabs'
import { isPluginSkill } from '@/lib/skillStore'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { getSandboxStatus } from '@/lib/agentTools'
import type { SandboxStatus } from '@janhq/tauri-plugin-agent-tools-api'
import {
  AgentEnableCard,
  CoworkRunsCard,
  ShellSandboxCard,
  SkillEditorDialog,
  SkillsCard,
  type SkillEditorState,
} from '@/containers/settings/AgentToolsSections'
import {
  storePath,
  revealStore,
  listSkills,
  readSkill,
  writeSkill,
  deleteSkill,
  type SkillMeta,
} from '@/lib/agentWorkspace'
import { errorText } from '@/lib/errorText'
import { CompactionPolicySettings } from '@/containers/CompactionPolicySettings'
import { AttributionSettings } from '@/containers/AttributionSettings'
import { ComputerExclusionSettings } from '@/containers/ComputerExclusionSettings'
import { BrowserAgentSettings } from '@/containers/BrowserAgentSettings'
import { SubagentSettings } from '@/containers/SubagentSettings'


export const Route = createFileRoute(route.settings.agent)({
  // Everything here is the desktop app's; a browser gets one line instead.
  component: () =>
    isServedByFlint() ? <DesktopOnlyTitle /> : <AgentToolsContent />,
})

type Editor = SkillEditorState

/** Shared so a rejected Tauri command never renders as `[object Object]`. */
const messageOf = errorText

const SKILL_TEMPLATE = '---\ndescription: \n---\n\n'

type AgentTab = 'run' | 'context' | 'sandbox' | 'skills'

function AgentToolsContent() {
  const { t } = useTranslation()
  // `undefined` until the probe answers, so the row reads as "checking" rather
  // than briefly claiming there is no sandbox.
  const [sandbox, setSandbox] = useState<SandboxStatus | undefined>()

  const [path, setPath] = useState('')
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [editor, setEditor] = useState<Editor | null>(null)
  const [saving, setSaving] = useState(false)
  // The page is long, so each kind of thing gets its own tab; a search result
  // opens the tab that holds the setting it names.
  const tabs: SettingsTab<AgentTab>[] = [
    {
      id: 'run',
      label: t('settings:agentTools.tabRun', { defaultValue: 'Run' }),
      anchors: [
        'settings-agent-tools-enable',
        'settings-agent-tools-chat-delegation',
        'settings-agent-tools-review-only-finish',
        'settings-campaigns-*',
        'settings-subagents-*',
      ],
    },
    {
      id: 'context',
      label: t('settings:agentTools.tabContext', { defaultValue: 'Context' }),
      anchors: ['settings-agent-tools-compaction'],
    },
    {
      id: 'sandbox',
      label: t('settings:agentTools.tabSandbox', { defaultValue: 'Sandbox and tools' }),
      anchors: [
        'settings-agent-tools-network',
        'settings-agent-tools-toolchains',
        'settings-agent-tools-computer-*',
        'settings-agent-tools-coauthor',
        'settings-agent-tools-pr-footer',
        'settings-agent-tools-browser',
      ],
    },
    {
      id: 'skills',
      label: `${t('settings:agentTools.skills')} (${skills.length})`,
    },
  ]
  const [tab, setTab] = useSettingsTab(tabs)
  const [query, setQuery] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [nextPath, nextSkills] = await Promise.all([
        storePath(),
        listSkills(),
      ])
      setPath(nextPath)
      setSkills(nextSkills)
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

  const openEditor = async (name?: string) => {
    if (!name) {
      setEditor({ name: '', content: SKILL_TEMPLATE })
      return
    }
    try {
      const content = await readSkill(name)
      setEditor({ original: name, name, content })
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
    // Writing has no create-only mode: a new (or renamed) entry must not
    // silently overwrite one that already has this name.
    const taken = skills.some((s) => s.name === name)
    if (taken && name !== editor.original) {
      toast.error(t('settings:agentTools.nameExists', { name }))
      return
    }
    setSaving(true)
    try {
      await writeSkill(name, editor.content)
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

  const remove = async (name: string) => {
    try {
      // Kept so the toast can undo a mistaken click on the trash icon.
      const content = await readSkill(name)
      await deleteSkill(name)
      await refresh()
      toast.success(t('settings:agentTools.deleted', { name }), {
        action: {
          label: t('common:undo'),
          onClick: () => {
            void (async () => {
              try {
                await writeSkill(name, content)
                await refresh()
              } catch (e) {
                toast.error(t('settings:agentTools.saveFailed'), {
                  description: messageOf(e),
                })
              }
            })()
          },
        },
      })
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

  const q = query.trim().toLowerCase()
  const matches = (name: string, description?: string) =>
    entryMatches(q, name, description)
  const ownSkills = skills.filter(
    (k) => !isPluginSkill(k) && matches(k.name, k.description)
  )
  const pluginSkills = skills.filter(
    (k) => isPluginSkill(k) && matches(k.name, k.description)
  )
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

  const addButton = (
    <Button
      variant="outline"
      className="pointer-coarse:h-11"
      onClick={() => openEditor()}
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
        actions={
          <SettingsTabStrip<AgentTab>
            // Remounted when the count arrives: the gliding pill is measured
            // once, and the Skills label grows after the list loads.
            key={skills.length}
            label={t('common:agent_tools')}
            tabs={tabs}
            value={tab}
            onChange={(v) => {
              setTab(v)
              setQuery('')
            }}
          />
        }
      >
        {tab === 'run' && (
          <AgentEnableCard path={path} onReveal={reveal} />
        )}

        {/* Cowork runs: what a run does when it finishes, where it works,
            and how many campaign tasks run at once. */}
        {tab === 'run' && <CoworkRunsCard />}

        {tab === 'run' && <SubagentSettings />}

        {tab === 'context' && isPlatformTauri() && (
          <CompactionPolicySettings />
        )}

        {tab === 'sandbox' && <ShellSandboxCard sandbox={sandbox} />}
        {tab === 'sandbox' && (
          <Card title={t('settings:agentTools.computerUse', { defaultValue: 'Computer use' })}>
            <ComputerExclusionSettings />
          </Card>
        )}
        {tab === 'sandbox' && (
          <Card title={t('settings:agentTools.gitCredit', { defaultValue: 'Git credit' })}>
            <AttributionSettings />
          </Card>
        )}
        {tab === 'sandbox' && <BrowserAgentSettings />}
        {tab === 'skills' && (
          <SkillsCard
            skills={skills}
            ownSkills={ownSkills}
            pluginSkills={pluginSkills}
            searchBox={searchBox}
            addButton={addButton}
            openEditor={openEditor}
            remove={remove}
          />
        )}
      </SettingsPageBody>

      <SkillEditorDialog
        editor={editor}
        setEditor={setEditor}
        saving={saving}
        save={save}
      />
    </div>
  )
}

function DesktopOnlyTitle() {
  const { t } = useTranslation()
  return <DesktopOnlyPage title={t('settings:agentTools.title')} />
}
