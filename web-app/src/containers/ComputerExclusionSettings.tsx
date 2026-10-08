import { useEffect, useRef, useState } from 'react'
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
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  captureDesktopPreview,
  getComputerExclusions,
  regionFromDrag,
  setComputerExclusions,
  type ExcludedRegion,
} from '@/lib/computerExclusions'

type Point = { x: number; y: number }

/**
 * Screen regions the assistant's `computer` tool never clicks, types or scrolls
 * in, e.g. a "New save" button that would overwrite the file being worked on.
 * Drawn on a capture of the desktop; stored in the data folder.
 */
export function ComputerExclusionSettings() {
  const { t } = useTranslation()
  const [regions, setRegions] = useState<ExcludedRegion[]>([])
  const [picking, setPicking] = useState(false)
  const [shot, setShot] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null)
  const [draft, setDraft] = useState<ExcludedRegion[]>([])
  const img = useRef<HTMLImageElement>(null)

  useEffect(() => {
    let live = true
    getComputerExclusions()
      .then((e) => live && setRegions(e.regions))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const save = (next: ExcludedRegion[]) => {
    const previous = regions
    setRegions(next)
    setComputerExclusions({ regions: next })
      .then((e) => setRegions(e.regions))
      .catch((e) => {
        setRegions(previous)
        toast.error(String(e))
      })
  }

  const open = async () => {
    setShot(null)
    setDraft(regions)
    setDrag(null)
    setPicking(true)
    try {
      setShot(await captureDesktopPreview())
    } catch (e) {
      setPicking(false)
      toast.error(String(e))
    }
  }

  const local = (e: React.PointerEvent): Point => {
    const r = img.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const finish = (to: Point) => {
    const el = img.current
    if (!drag || !el) return
    const r = regionFromDrag(
      drag.from,
      to,
      { width: el.clientWidth, height: el.clientHeight },
      { width: el.naturalWidth, height: el.naturalHeight }
    )
    setDrag(null)
    if (r.width >= 4 && r.height >= 4) setDraft((d) => [...d, r])
  }

  // Overlay boxes are drawn in percentages of the natural size.
  const box = (r: ExcludedRegion, key: string, live = false) => {
    const el = img.current
    if (!el?.naturalWidth) return null
    return (
      <div
        key={key}
        className={`absolute border-2 ${live ? 'border-primary bg-primary/20' : 'border-destructive bg-destructive/25'} pointer-events-none`}
        style={{
          left: `${(r.x / el.naturalWidth) * 100}%`,
          top: `${(r.y / el.naturalHeight) * 100}%`,
          width: `${(r.width / el.naturalWidth) * 100}%`,
          height: `${(r.height / el.naturalHeight) * 100}%`,
        }}
      />
    )
  }

  const dragRegion =
    drag && img.current
      ? regionFromDrag(
          drag.from,
          drag.to,
          { width: img.current.clientWidth, height: img.current.clientHeight },
          { width: img.current.naturalWidth, height: img.current.naturalHeight }
        )
      : null

  return (
    <>
      <CardItem
        anchor="settings-agent-tools-computer-exclusions"
        title={t('settings:agentTools.computerExclusions')}
        description={
          regions.length === 0
            ? t('settings:agentTools.computerExclusionsDesc')
            : t('settings:agentTools.computerExclusionsCount', {
                count: regions.length,
              })
        }
        align="start"
        actions={
          <Button
            size="sm"
            variant="outline"
            data-testid="computer-exclusions-edit"
            onClick={open}
          >
            {t('settings:agentTools.computerExclusionsEdit')}
          </Button>
        }
      />
      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {t('settings:agentTools.computerExclusions')}
            </DialogTitle>
            <DialogDescription>
              {t('settings:agentTools.computerExclusionsPick')}
            </DialogDescription>
          </DialogHeader>
          <div className="relative select-none touch-none">
            {shot ? (
              <>
                <img
                  ref={img}
                  src={shot}
                  alt=""
                  draggable={false}
                  className="w-full cursor-crosshair rounded-md border"
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId)
                    const p = local(e)
                    setDrag({ from: p, to: p })
                  }}
                  onPointerMove={(e) =>
                    drag && setDrag({ from: drag.from, to: local(e) })
                  }
                  onPointerUp={(e) => finish(local(e))}
                />
                {draft.map((r, i) => box(r, `r${i}`))}
                {dragRegion && box(dragRegion, 'drag', true)}
              </>
            ) : (
              <div className="py-16 text-center text-sm text-muted-foreground">
                {t('settings:agentTools.computerExclusionsCapturing')}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={draft.length === 0}
              onClick={() => setDraft((d) => d.slice(0, -1))}
            >
              {t('settings:agentTools.computerExclusionsUndo')}
            </Button>
            <Button variant="ghost" onClick={() => setDraft([])}>
              {t('settings:agentTools.computerExclusionsClear')}
            </Button>
            <Button
              data-testid="computer-exclusions-save"
              onClick={() => {
                save(draft)
                setPicking(false)
              }}
            >
              {t('settings:agentTools.computerExclusionsSave')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
