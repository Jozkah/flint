import type { ComponentProps } from 'react'
import { ClaudeSkillRootsSettings } from '@/containers/ClaudeSkillRootsSettings'
import { CoworkCompatSection } from '@/containers/CoworkCompatSection'
import { CoworkContextBreakdown } from '@/containers/CoworkContextBreakdown'
import { CoworkEnvironmentReadiness } from '@/containers/CoworkEnvironmentReadiness'
import { CoworkEventExport } from '@/containers/CoworkEventExport'
import { CoworkReadinessCard } from '@/containers/CoworkReadinessCard'
import { ModelDoctor } from '@/containers/ModelDoctor'
import { SessionMessagingToggle } from '@/containers/SessionMessagingToggle'
import { useClaudeCompat } from '@/hooks/useClaudeCompat'
import { type ContextAccounting } from '@/lib/coworkReadiness'
import { projectListDir } from '@janhq/tauri-plugin-agent-tools-api'
import type { CoworkSession } from '@/hooks/useCoworkSessions'
import type { CompatibilityManifest, McpProbe } from '@/lib/claudeCompat'
import type { ReadinessManifest } from '@/lib/coworkReadiness'
import type { ServiceHub } from '@/services'
import type { ComponentReport } from '@janhq/tauri-plugin-agent-tools-api'

type CoworkDetailsBodyProps = {
  readiness: ReadinessManifest
  settingsMcpServers: number
  selectedProvider: string
  getProviderByName: (providerName: string) => ModelProvider | undefined
  selectedModel: ComponentProps<typeof ModelDoctor>['model'] | null
  session: CoworkSession | null
  serviceHub: ServiceHub
  folder: string | null
  rendererReports: ComponentReport[]
  runContext: ContextAccounting | null
  compat: CompatibilityManifest
  mcpProbes: readonly McpProbe[]
  setMcpConsent: (probe: McpProbe, allowed: boolean) => Promise<void>
  skillRoots: string[]
  janDataFolder: string | null
  rescanCompat: () => void
}

export function CoworkDetailsBody({
  readiness,
  settingsMcpServers,
  selectedProvider,
  getProviderByName,
  selectedModel,
  session,
  serviceHub,
  folder,
  rendererReports,
  runContext,
  compat,
  mcpProbes,
  setMcpConsent,
  skillRoots,
  janDataFolder,
  rescanCompat,
}: CoworkDetailsBodyProps) {
  return (
    <>
      <CoworkReadinessCard
        manifest={readiness}
        settingsMcpServers={settingsMcpServers}
        modelTest={
          <ModelDoctor
            provider={selectedProvider ? getProviderByName(selectedProvider) : undefined}
            model={selectedModel ?? undefined}
          />
        }
      />
      {/* Whether other sessions may write to this one, and whether it answers
          them on its own. Here, not only on a held message, so it can be
          decided before anyone writes. */}
      {session?.id && <SessionMessagingToggle sessionId={session.id} />}
      {/* AH-177: this session's canonical events, written to a file. */}
      <CoworkEventExport
        sessionId={session?.id}
        pickFolder={async () => {
          const picked = await serviceHub.dialog().open({ directory: true })
          return typeof picked === 'string' ? picked : null
        }}
      />
      {/* Collapsed, and inside session details rather than above the
          composer: someone whose session works should never read it. */}
      <CoworkEnvironmentReadiness
        projectRoot={folder ?? undefined}
        reported={rendererReports}
        collapsible
      />
      {runContext && <CoworkContextBreakdown context={runContext} />}
      <CoworkCompatSection
        manifest={compat}
        hasFolder={Boolean(folder)}
        onToggle={(on) =>
          folder && useClaudeCompat.getState().setEnabled(folder, on)
        }
        // Drives Flint's own MCP subsystem, against the definition as it
        // stands on disk: consent is permission to run *this* server,
        // not whatever the file says later.
        onMcpConsent={(server, allowed) => {
          const probe = mcpProbes.find((one) => one.name === server)
          if (probe) void setMcpConsent(probe, allowed)
        }}
      />
      <ClaudeSkillRootsSettings
        collapsible
        roots={skillRoots}
        onChange={(next) => useClaudeCompat.getState().setSkillRoots(next)}
        janData={janDataFolder}
        onRescan={rescanCompat}
        pickFolder={async () => {
          const picked = await serviceHub.dialog().open({ directory: true })
          return typeof picked === 'string' ? picked : null
        }}
        // The backend is the only thing that can tell a directory from a
        // file, or from a path that has since gone.
        confirmDirectory={async (path) => {
          const dataFolder = janDataFolder
          if (!dataFolder) return false
          try {
            await projectListDir(dataFolder, path, '.')
            return true
          } catch {
            return false
          }
        }}
      />
    </>
  )
}
