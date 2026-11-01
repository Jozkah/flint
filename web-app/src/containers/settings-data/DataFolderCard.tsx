import { useState } from 'react'
import { Copy, CopyCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { Card, CardItem } from '@/containers/Card'
import ChangeDataFolderLocation from '@/containers/dialogs/ChangeDataFolderLocation'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { SystemEvent } from '@/types/events'
import { isRootDir } from '@/utils/path'

type Props = {
  janDataFolder: string | undefined
  setJanDataFolder: (path: string | undefined) => void
  /** The saved folder that could not be used, if any. */
  unavailableDataFolder: string | undefined
}

/** Where the app keeps its data, and its logs. Desktop only. */
export function DataFolderCard({
  janDataFolder,
  setJanDataFolder,
  unavailableDataFolder,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [isCopied, setIsCopied] = useState(false)
  const [selectedNewPath, setSelectedNewPath] = useState<string | null>(null)
  const [isDialogOpen, setIsDialogOpen] = useState(false)

  const openFileTitle = (): string => {
    if (IS_MACOS) {
      return t('settings:general.showInFinder')
    } else if (IS_WINDOWS) {
      return t('settings:general.showInFileExplorer')
    } else {
      return t('settings:general.openContainingFolder')
    }
  }

  const handleOpenLogs = async () => {
    try {
      await serviceHub.window().openLogsWindow()
    } catch (error) {
      console.error('Failed to open logs window:', error)
    }
  }

  const handleExportLogs = async () => {
    try {
      const path = await serviceHub.app().exportRedactedLogs()
      if (!path) return
      toast.success(t('settings:general.exportLogsSaved', { path }))
    } catch (error) {
      toast.error(t('settings:general.exportLogsFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleSaveBundle = async () => {
    try {
      const path = await serviceHub.app().exportDiagnosticBundle()
      if (!path) return
      toast.success(t('settings:general.diagnosticBundleSaved', { path }))
    } catch (error) {
      toast.error(t('settings:general.diagnosticBundleFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setIsCopied(true)
      setTimeout(() => setIsCopied(false), 2000) // Reset after 2 seconds
    } catch (error) {
      console.error('Failed to copy to clipboard:', error)
    }
  }

  const handleDataFolderChange = async () => {
    const selectedPath = await serviceHub.dialog().open({
      multiple: false,
      directory: true,
      defaultPath: janDataFolder,
    })

    if (selectedPath === janDataFolder) return
    if (selectedPath !== null) {
      // Reject a drive/filesystem root up front, before the confirm dialog
      // can stop models or kill the sidecar (e.g. C:\ on Windows, / on Unix).
      if (isRootDir(selectedPath as string)) {
        toast.error(t('settings:general.couldNotRelocateToRoot'))
        return
      }
      setSelectedNewPath(selectedPath as string)
      setIsDialogOpen(true)
    }
  }

  const confirmDataFolderChange = async () => {
    if (selectedNewPath) {
      // Validate before any destructive step: stopping models and killing the
      // sidecar for a path that will be rejected anyway is needless disruption.
      if (isRootDir(selectedNewPath)) {
        toast.error(t('settings:general.couldNotRelocateToRoot'))
        return
      }
      try {
        await serviceHub.models().stopAllModels()
        serviceHub.events().emit(SystemEvent.KILL_SIDECAR)
        setTimeout(async () => {
          try {
            await serviceHub.app().relocateJanDataFolder(selectedNewPath)
            setJanDataFolder(selectedNewPath)
            // Only relaunch if relocation was successful
            window.core?.api?.relaunch()
            setSelectedNewPath(null)
            setIsDialogOpen(false)
          } catch (error) {
            console.error(error)
            // The folder did not move: close the dialog instead of leaving it
            // open over a half-done change (RTE-006).
            setSelectedNewPath(null)
            setIsDialogOpen(false)
            toast.error(
              error instanceof Error
                ? error.message
                : t('settings:general.failedToRelocateDataFolder')
            )
          }
        }, 1000)
      } catch (error) {
        console.error('Failed to relocate data folder:', error)
        // Revert the data folder path on error
        const originalPath = await serviceHub.app().getJanDataFolder()
        setJanDataFolder(originalPath)

        toast.error(t('settings:general.failedToRelocateDataFolderDesc'))
      }
    }
  }

  const revealLogs = async () => {
    if (janDataFolder) {
      try {
        const logsPath = await serviceHub.path().join(janDataFolder, 'logs')
        await serviceHub.opener().openPath(logsPath)
      } catch (error) {
        console.error('Failed to reveal logs folder:', error)
      }
    }
  }

  const copyLabel = isCopied
    ? t('settings:general.copied')
    : t('settings:general.copyPath')

  return (
    <Card title={t('common:dataFolder')}>
      <CardItem
        anchor="settings-data-data-folder"
        title={t('settings:dataFolder.appData', {
          ns: 'settings',
        })}
        column
        description={
          <>
            {t('settings:dataFolder.appDataDesc', {
              ns: 'settings',
            })}
            {unavailableDataFolder && (
              <p role="alert" className="text-xs text-destructive mt-1">
                {t('settings:dataFolder.unavailable', {
                  path: unavailableDataFolder,
                })}
              </p>
            )}
          </>
        }
        actions={
          <>
            <span className="flex h-8 min-w-0 flex-1 items-center gap-1 overflow-hidden rounded-lg border-[0.8px] border-border bg-muted py-0 pr-1 pl-2.5 pointer-coarse:h-11">
              <span
                data-testid="app-data-folder-path"
                title={janDataFolder}
                className="min-w-0 flex-1 truncate font-mono text-xs text-fg-2"
              >
                {janDataFolder}
              </span>
              <button
                type="button"
                onClick={() => janDataFolder && copyToClipboard(janDataFolder)}
                className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover-btn hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11"
                title={copyLabel}
                aria-label={copyLabel}
              >
                {isCopied ? (
                  <CopyCheck size={14} className="text-success" aria-hidden />
                ) : (
                  <Copy size={14} aria-hidden />
                )}
              </button>
            </span>
            <Button
              variant="outline"
              className="pointer-coarse:h-11"
              title={t('settings:dataFolder.appData')}
              onClick={handleDataFolderChange}
            >
              <Icon name="x-folder" size={14} />
              <span>{t('settings:general.changeLocation')}</span>
            </Button>
            {selectedNewPath && (
              <ChangeDataFolderLocation
                currentPath={janDataFolder || ''}
                newPath={selectedNewPath}
                onConfirm={confirmDataFolderChange}
                open={isDialogOpen}
                onOpenChange={(open) => {
                  setIsDialogOpen(open)
                  if (!open) {
                    setSelectedNewPath(null)
                  }
                }}
              >
                <div />
              </ChangeDataFolderLocation>
            )}
          </>
        }
      />
      <CardItem
        anchor="settings-data-logs"
        title={t('settings:dataFolder.appLogs', {
          ns: 'settings',
        })}
        description={t('settings:dataFolder.appLogsDesc')}
        className="items-start"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="pointer-coarse:h-11"
              onClick={revealLogs}
              title={t('settings:general.revealLogs')}
            >
              <Icon name="x-folder" size={14} />
              <span>{openFileTitle()}</span>
            </Button>
            <Button
              variant="outline"
              onClick={handleOpenLogs}
              title={t('settings:dataFolder.appLogs')}
            >
              <Icon name="sb-file" size={14} />
              <span>{t('settings:general.openLogs')}</span>
            </Button>
            {IS_TAURI && (
              <Button
                variant="outline"
                onClick={handleExportLogs}
                title={t('settings:general.exportLogsDesc')}
              >
                <span>{t('settings:general.exportLogs')}</span>
              </Button>
            )}
            {IS_TAURI && (
              <Button
                variant="outline"
                onClick={handleSaveBundle}
                title={t('settings:general.diagnosticBundleDesc')}
              >
                <span>{t('settings:general.diagnosticBundle')}</span>
              </Button>
            )}
          </div>
        }
      />
    </Card>
  )
}
