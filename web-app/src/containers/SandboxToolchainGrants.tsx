/**
 * Settings > Agent Tools: toolchains the Windows sandbox cannot run, and the
 * opt-in that lets it.
 *
 * A toolchain installed under the user profile (Python from python.org, Node
 * through nvm) is on the PATH but its folder does not admit app packages, so
 * the sandboxed shell cannot start it. Granting adds one permission entry to
 * that toolchain's install folder; it is a change on disk, so it is asked for
 * explicitly and can be taken back.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  sandboxToolchainGrant,
  sandboxToolchainGrants,
  sandboxToolchainRevoke,
  type ToolchainGrant,
  type ToolchainReport,
} from '@janhq/tauri-plugin-agent-tools-api'
import { toast } from 'sonner'
import { CardItem } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { getSandboxToolchains } from '@/lib/agentTools'
import { errorText } from '@/lib/errorText'

export function SandboxToolchainGrants() {
  const { t } = useTranslation()
  const [report, setReport] = useState<ToolchainReport | null>(null)
  const [grants, setGrants] = useState<ToolchainGrant[]>([])
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setReport(await getSandboxToolchains())
    try {
      setGrants(await sandboxToolchainGrants())
    } catch {
      setGrants([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const grant = async () => {
    if (!confirming) return
    setBusy(true)
    try {
      await sandboxToolchainGrant(confirming)
      toast.success(
        t('settings:agentTools.toolchains.granted', { program: confirming })
      )
      setConfirming(null)
      await refresh()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (folder: string) => {
    setBusy(true)
    try {
      await sandboxToolchainRevoke(folder)
      await refresh()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  // Only the Windows sandbox reports toolchains; elsewhere there is nothing
  // to grant, and no grant to revoke either.
  if (!report && grants.length === 0) return null
  const unavailable = report?.unavailable ?? []

  return (
    <>
      <CardItem
        anchor="settings-agent-tools-toolchains"
        title={t('settings:agentTools.toolchains.title')}
        align="start"
        description={
          unavailable.length === 0 && grants.length === 0
            ? t('settings:agentTools.toolchains.allRunnable')
            : t('settings:agentTools.toolchains.description')
        }
      />
      {unavailable.map((program) => (
        <CardItem
          key={`u-${program}`}
          title={<code>{program}</code>}
          description={t('settings:agentTools.toolchains.unrunnable')}
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              data-testid={`toolchain-grant-${program}`}
              onClick={() => setConfirming(program)}
            >
              {t('settings:agentTools.toolchains.grant')}
            </Button>
          }
        />
      ))}
      {grants.map((g) => (
        <CardItem
          key={`g-${g.folder}`}
          title={<code>{g.program}</code>}
          description={t('settings:agentTools.toolchains.grantedAt', {
            folder: g.folder,
          })}
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              data-testid={`toolchain-revoke-${g.program}`}
              onClick={() => void revoke(g.folder)}
            >
              {t('settings:agentTools.toolchains.revoke')}
            </Button>
          }
        />
      ))}

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => !open && !busy && setConfirming(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('settings:agentTools.toolchains.confirmTitle', {
                program: confirming ?? '',
              })}
            </DialogTitle>
            <DialogDescription>
              {t('settings:agentTools.toolchains.confirmBody', {
                program: confirming ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className={STICKY_DIALOG_FOOTER}>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirming(null)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              disabled={busy}
              data-testid="toolchain-grant-confirm"
              onClick={() => void grant()}
            >
              {t('settings:agentTools.toolchains.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
