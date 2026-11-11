import { useCallback, useEffect, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import { useCopiedFlag } from '@/hooks/useCopiedFlag'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isServedByFlint } from '@/lib/platform/utils'
import {
  TTL_CHOICES,
  guestApi,
  guestLinkUrl,
  nearestTtl,
  type GuestApi,
  type GuestShare,
} from '@/lib/guestShare'

/** Links made this session, kept in memory: the backend never stores a token. */
const shownLinks = new Map<string, { link: string; complete: boolean }>()

const ttlKey = (hours: number) => `chat:guest.ttl${hours}`

/**
 * "Share with guest": one thread, one person, no account. Opt-in (the setting
 * is off until turned on here or in Settings > Chat), so it first explains what a
 * link exposes. The link is shown once, when made.
 */
export function ShareGuestDialog({
  threadId,
  open,
  onOpenChange,
  api = guestApi,
}: {
  threadId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  api?: GuestApi
}) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [share, setShare] = useState<GuestShare | null>(null)
  const [ttl, setTtl] = useState<number>(24)
  const [reasoning, setReasoning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useCopiedFlag()

  const refresh = useCallback(async () => {
    try {
      const on = await api.getEnabled()
      setEnabled(on)
      if (!on) return setShare(null)
      const [active] = await api.list(threadId)
      setShare(active ?? null)
      if (active) setTtl(nearestTtl(active.expiresMs, Date.now()))
    } catch {
      setEnabled(false)
    }
  }, [api, threadId])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  const fail = () => toast.error(t('chat:guest.failed'))

  const turnOn = async (on: boolean) => {
    setBusy(true)
    try {
      setEnabled(await api.setEnabled(on))
      if (!on) setShare(null)
    } catch {
      fail()
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    setBusy(true)
    try {
      const made = await api.create(threadId, {
        ttlHours: ttl,
        includeReasoning: reasoning,
      })
      shownLinks.set(
        made.share.id,
        guestLinkUrl(made, isServedByFlint() ? window.location.origin : null)
      )
      setShare(made.share)
    } catch {
      fail()
    } finally {
      setBusy(false)
    }
  }

  const changeTtl = async (hours: number) => {
    setTtl(hours)
    if (!share) return
    try {
      setShare(await api.extend(share.id, hours))
    } catch {
      fail()
    }
  }

  const stop = async () => {
    if (!share) return
    setBusy(true)
    try {
      await api.stop(share.id)
      shownLinks.delete(share.id)
      setShare(null)
      toast.success(t('chat:guest.stopped'))
    } catch {
      fail()
    } finally {
      setBusy(false)
    }
  }

  const shown = share ? shownLinks.get(share.id) : undefined
  const copy = async () => {
    if (!shown) return
    try {
      await navigator.clipboard.writeText(shown.link)
      setCopied(true)
    } catch {
      toast.error(t('chat:guest.failed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="share-guest-dialog">
        <DialogHeader>
          <DialogTitle>{t('chat:guest.title')}</DialogTitle>
          <DialogDescription>{t('chat:guest.intro')}</DialogDescription>
        </DialogHeader>

        {enabled === false && (
          <div className="flex items-start justify-between gap-3 rounded-lg bg-muted/60 p-3">
            <div className="min-w-0 text-sm">
              <p className="font-medium">{t('chat:guest.offTitle')}</p>
              <p className="text-muted-foreground">{t('chat:guest.offBody')}</p>
            </div>
            <Switch
              checked={false}
              disabled={busy}
              onCheckedChange={() => void turnOn(true)}
              aria-label={t('chat:guest.enable')}
              data-testid="guest-enable"
            />
          </div>
        )}

        {enabled && !share && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t('chat:guest.expiry')}</span>
              <Segmented
                size="sm"
                aria-label={t('chat:guest.expiry')}
                value={String(ttl)}
                onValueChange={(v) => setTtl(Number(v))}
                options={TTL_CHOICES.map((h) => ({
                  value: String(h),
                  label: t(ttlKey(h)),
                }))}
              />
            </div>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>{t('chat:guest.includeReasoning')}</span>
              <Switch checked={reasoning} onCheckedChange={setReasoning} />
            </label>
            <Button disabled={busy} onClick={() => void create()} data-testid="guest-create">
              {t('chat:guest.create')}
            </Button>
          </div>
        )}

        {enabled && share && (
          <div className="flex flex-col gap-3" data-testid="guest-active">
            {shown ? (
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={shown.link}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label={t('chat:guest.link')}
                  data-testid="guest-link"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void copy()}
                  aria-label={t('chat:guest.copy')}
                >
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  <span>{copied ? t('chat:guest.copied') : t('chat:guest.copy')}</span>
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('chat:guest.linkGone')}</p>
            )}
            {shown && !shown.complete && (
              <p className="text-xs text-muted-foreground">{t('chat:guest.pathOnly')}</p>
            )}
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                {t('chat:guest.expires', {
                  when: new Date(share.expiresMs).toLocaleString(),
                })}
              </span>
              <Segmented
                size="sm"
                aria-label={t('chat:guest.expiry')}
                value={String(ttl)}
                onValueChange={(v) => void changeTtl(Number(v))}
                options={TTL_CHOICES.map((h) => ({
                  value: String(h),
                  label: t(ttlKey(h)),
                }))}
              />
              <p className="text-xs text-muted-foreground">{t('chat:guest.extendNote')}</p>
            </div>
            <p className="text-xs text-muted-foreground">
              {share.joined ? t('chat:guest.joined') : t('chat:guest.notJoined')}
            </p>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void stop()}
              data-testid="guest-stop"
            >
              {t('chat:guest.stop')}
            </Button>
          </div>
        )}

        <p className="text-xs text-muted-foreground">{t('chat:guest.reachable')}</p>
      </DialogContent>
    </Dialog>
  )
}
