import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { getServiceHub } from '@/hooks/useServiceHub'
import { errorText } from '@/lib/errorText'
import {
  listAccessGrants,
  revokeAccess,
  type AccessGrant,
} from '@/lib/accessRequests'

const ROW =
  'flex flex-col gap-2 border-b border-border py-2.5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4'
const EMPTY = 'py-3 text-[13px] text-muted-foreground'
const REVOKE = 'self-start shrink-0 pointer-coarse:h-11 sm:self-auto'

function lifetime(g: AccessGrant): string {
  if (g.persistent || g.expiresAt === null) return 'Every conversation, until revoked'
  return `This conversation, until ${new Date(g.expiresAt * 1000).toLocaleString()}`
}

/**
 * Every folder or file an agent was granted through `request_access`, with a
 * way to take each one back. Revoking takes effect on the next tool call.
 */
export function FolderAccessCard() {
  const [grants, setGrants] = useState<AccessGrant[] | null>(null)

  const reload = useCallback(async () => {
    try {
      const dataFolder = await getServiceHub().app().getJanDataFolder()
      if (!dataFolder) return setGrants([])
      setGrants(await listAccessGrants(dataFolder))
    } catch (e) {
      toast.error(errorText(e))
      setGrants([])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const revoke = async (g: AccessGrant) => {
    try {
      const dataFolder = await getServiceHub().app().getJanDataFolder()
      if (dataFolder) await revokeAccess(dataFolder, g.id)
    } catch (e) {
      toast.error(errorText(e))
    }
    await reload()
  }

  return (
    <Card
      anchor="settings-permissions-folder-access"
      title="Folder access"
      description="Folders and files outside the agent workspace that you let an agent read or change."
      aside={<span className="tabular-nums">{grants?.length ?? 0}</span>}
      data-testid="folder-access-card"
    >
      {!grants || grants.length === 0 ? (
        <p className={EMPTY}>No folder access has been granted.</p>
      ) : (
        <ul className="flex flex-col">
          {grants.map((g) => (
            <li key={g.id} className={ROW} data-testid="folder-access-row">
              <div className="min-w-0 space-y-0.5">
                <p className="break-all font-mono text-xs text-foreground">
                  {g.display}
                </p>
                <p className="text-[13px] text-muted-foreground">
                  {g.mode === 'write' ? 'Read and write' : 'Read only'} ·{' '}
                  {lifetime(g)}
                </p>
                {g.reason && (
                  <p className="break-words text-[13px] text-muted-foreground">
                    “{g.reason}”
                  </p>
                )}
              </div>
              <Button
                variant="destructive"
                className={REVOKE}
                aria-label={`Revoke access to ${g.display}`}
                onClick={() => void revoke(g)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
