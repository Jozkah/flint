/**
 * Controller for the native web preview: a Tauri child webview laid over the
 * preview panel's content box. Native views sit above all HTML, so this
 * keeps the view's physical bounds in sync with the DOM box and hides it
 * whenever it should not be seen (panel hidden, empty box, a dialog or menu
 * open). Kept free of React so bounds/visibility logic is unit-testable with
 * a mocked invoke.
 */

export type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

export type PhysicalBounds = { x: number; y: number; width: number; height: number }

type RectLike = { left: number; top: number; width: number; height: number }

/** CSS-pixel DOM rect -> physical window pixels. `dpr` already includes app zoom. */
export function toPhysicalBounds(rect: RectLike, dpr: number): PhysicalBounds {
  const x = Math.round(rect.left * dpr)
  const y = Math.round(rect.top * dpr)
  return {
    x,
    y,
    width: Math.max(0, Math.round((rect.left + rect.width) * dpr) - x),
    height: Math.max(0, Math.round((rect.top + rect.height) * dpr) - y),
  }
}

export function sameBounds(a: PhysicalBounds | null, b: PhysicalBounds | null) {
  return (
    !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  )
}

/**
 * Selector for overlays that must not be covered by the native view: open
 * Radix dialogs/alert dialogs, menus, popovers, selects and sheets.
 */
export const OVERLAY_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
  '[data-radix-popper-content-wrapper]',
].join(',')

function intersects(a: RectLike, b: RectLike) {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  )
}

/**
 * Whether an overlay the native view would cover is open. Modal dialogs
 * always count; popovers/menus/tooltips only when they overlap `previewRect`.
 */
export function hasBlockingOverlay(
  root: ParentNode,
  previewRoot?: Element | null,
  previewRect?: RectLike | null
): boolean {
  const nodes = root.querySelectorAll(OVERLAY_SELECTOR)
  for (const n of Array.from(nodes)) {
    // Ignore anything that contains the preview (e.g. the PIP surface) or
    // lives inside it.
    if (previewRoot && (n.contains(previewRoot) || previewRoot.contains(n))) continue
    const role = n.getAttribute('role')
    if (role === 'dialog' || role === 'alertdialog') return true
    if (!previewRect) return true
    if (intersects(n.getBoundingClientRect(), previewRect)) return true
  }
  return false
}

export class NativeWebPreviewController {
  private created = false
  private shown = false
  private lastBounds: PhysicalBounds | null = null
  private pendingBounds: PhysicalBounds | null = null
  private frame: number | null = null
  private disposed = false

  constructor(
    readonly id: string,
    private readonly invoke: InvokeFn,
    private readonly raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
    private readonly caf: (h: number) => void = (h) => cancelAnimationFrame(h)
  ) {}

  /** Fire-and-forget command; failures (view already gone) are ignored. */
  private fire(cmd: string, args: Record<string, unknown>) {
    try {
      void Promise.resolve(this.invoke(cmd, args)).catch(() => {})
    } catch {
      /* ignore */
    }
  }

  get isCreated() {
    return this.created
  }

  /** Create (or reuse) the native view. Rejects if the platform cannot. */
  async create(url: string, bounds: PhysicalBounds): Promise<void> {
    await this.invoke('web_preview_create', { id: this.id, url, bounds })
    if (this.disposed) {
      this.fire('web_preview_close', { id: this.id })
      return
    }
    this.created = true
    this.shown = true
    this.lastBounds = bounds
  }

  /**
   * Queue a bounds update; at most one set_bounds per animation frame and
   * only when the rect actually changed.
   */
  setBounds(bounds: PhysicalBounds) {
    if (!this.created || this.disposed) return
    this.pendingBounds = bounds
    if (this.frame !== null) return
    this.frame = this.raf(() => {
      this.frame = null
      const b = this.pendingBounds
      this.pendingBounds = null
      if (!b || sameBounds(b, this.lastBounds)) return
      this.lastBounds = b
      this.fire('web_preview_set_bounds', { id: this.id, bounds: b })
    })
  }

  setVisible(visible: boolean) {
    if (!this.created || this.disposed || visible === this.shown) return
    this.shown = visible
    this.fire(visible ? 'web_preview_show' : 'web_preview_hide', { id: this.id })
  }

  navigate(url: string) {
    if (!this.created || this.disposed) return Promise.resolve()
    return this.invoke('web_preview_navigate', { id: this.id, url })
  }

  reload() {
    if (!this.created || this.disposed) return Promise.resolve()
    return this.invoke('web_preview_reload', { id: this.id })
  }

  back() {
    if (!this.created || this.disposed) return Promise.resolve()
    return this.invoke('web_preview_back', { id: this.id })
  }

  forward() {
    if (!this.created || this.disposed) return Promise.resolve()
    return this.invoke('web_preview_forward', { id: this.id })
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.frame !== null) this.caf(this.frame)
    this.frame = null
    if (this.created) {
      this.created = false
      this.fire('web_preview_close', { id: this.id })
    }
  }
}
