import { GUIDE_MODULES, type GuideModule } from './constants'

/**
 * Design guidance returned by `visualize_read_me`. Kept short on purpose: a
 * small local model reads it once per conversation, and every line costs
 * context.
 */
const CORE = `# Widget guide (core)
A widget is an HTML fragment shown inline in the chat, in a sandboxed frame. No <html>, <head> or <body> tags. Order: a short <style>, the markup, then a <script> if it needs interaction.

WHEN: structure, flow, data, a layout or a mockup the user asked to "see", or a small interactive explainer. NOT for a plain answer, a list, code, or anything text says as well. At most one widget per answer unless asked. Say in text what the widget shows; do not repeat its labels.

LOOK: the app injects CSS variables, so the widget matches light and dark mode. Never hard-code colours or fonts.
- Colours: var(--background) var(--card) var(--muted) var(--foreground) var(--muted-foreground) var(--border) var(--border-strong) var(--primary) var(--primary-foreground) var(--accent) var(--success) var(--warning) var(--destructive) var(--info). Chart colours: var(--chart-1) .. var(--chart-5).
- Shape: var(--radius), var(--radius-sm). Fonts: var(--font-sans), var(--font-mono).
- Already styled for you: h1-h4, p, a, button (add class "primary" for the main one), input, select, textarea, table, code, pre. Helpers: .card (bordered panel), .row (flex, centred), .between, .wrap, .stack (column), .grid (responsive columns), .badge, .muted, .ok .warn .err (text colour), .list (rows with a divider), input.toggle (a switch: <input type="checkbox" class="toggle">).
- Flat design: 1px borders, no shadows, no gradients, no emoji as icons. Small text 12-14px. Generous padding (12-16px).

LAYOUT: the width is the chat column and varies. Use flex/grid, %, auto-fit; never a fixed pixel width on the outer element and never 100vh/vw (the height follows the content, up to a limit, then scrolls). Keep it under about 4 KB of markup for simple widgets and never above 30 KB.

RULES: no network (no fetch, no external images, fonts or stylesheets; use inline SVG or data: URIs). Libraries are only available if the user enabled them in Settings; otherwise write vanilla JS. Put scripts last; the markup exists when they run. Use id attributes and addEventListener, not inline handlers in loops. Wrap risky code in try/catch and keep state in plain variables.
ACCESSIBILITY: real <button> elements for actions, <label> for inputs, sufficient contrast through the variables, an aria-label or <title> on SVGs.
BRIDGE: flint.sendPrompt("text") sends text as the user's next message, only from inside a click or key handler (use it for "Explain this", "Make it dark", "Pick option B"). flint.openLink("https://...") opens a link in the system browser after the user confirms. Nothing else reaches the app.
CALL: show_widget({title, loading_messages?, widget_code}). title is a short caption. loading_messages: 1-4 short status lines shown while the code is still being written, e.g. ["Laying out the sections", "Adding the toggles"].`

const MODULES: Record<GuideModule, string> = {
  diagram: `## diagram
Use inline <svg viewBox="0 0 680 H"> with NO width/height attributes; it then scales to the column. Pick H to fit (aim 260-420). Boxes: <rect rx="8" fill="var(--card)" stroke="var(--border-strong)"/>; the focus node uses fill="var(--accent)" stroke="var(--primary)". Text: font-size 12-13, text-anchor="middle", fill stays var(--foreground) (set by default), secondary text fill="var(--muted-foreground)". Arrows: <path d="M x1 y1 L x2 y2" stroke="var(--muted-foreground)" fill="none" marker-end="url(#a)"> with one <marker id="a"> in <defs>. Leave 16px gaps, align on a grid of 20, 4-9 nodes max, left-to-right or top-to-bottom, label arrows only when needed. Colour means something: at most 3 colours, taken from --chart-N.`,
  mockup: `## mockup
Rebuild the real UI with the app's own look: .card panels, .list rows with a label left and a control right (input.toggle, select, a value in .muted), h3 section titles, .badge tags. Use realistic labels and values, never lorem ipsum. Two columns with .grid. Make controls work (toggles flip, tabs switch, a search box filters) with a few lines of JS; do not fake state with images. Show 4-8 rows, not 30. Do not draw browser or window chrome around it.`,
  chart: `## chart
Pure SVG or CSS bars; one chart, one message. Bars: flex columns or <rect>, colour var(--chart-1), compare series with --chart-2..5. Always draw: a title in the caption (not inside), axis labels, 3-5 gridlines (stroke var(--border)), values on or above bars. Paint order is source order: put the gridlines first so the bars sit on top of them. Reserve room for labels: leave a left margin of about 48 (value labels, text-anchor="end" at x=40) and a bottom margin of about 32 inside the viewBox, so no label is clipped or touches a bar. Hover tooltips: one absolutely positioned div moved on mousemove, showing the exact value. Compute scales in JS from a data array at the top of the script so the numbers are easy to change. Legend only for 2+ series. No 3D, no pie charts over 5 slices.`,
  interactive: `## interactive
A calculator, simulator, sorter, quiz or explorer: inputs on top (range sliders, selects, number fields), a live result below that updates on the "input" event, plus sensible defaults so it is useful before touching anything. Show the formula or rule being applied. Keep state in one object and one render() function. Validate numbers (isFinite) and show a friendly message for bad input. Offer a sendPrompt button for follow-ups such as "Explain these results" only when the user would plausibly want it.`,
  art: `## art
Illustration or decorative SVG: viewBox with no width/height, a restrained palette from the variables (use opacity for tints), simple geometry, clear silhouette, no text unless needed. Animate only with CSS (transform/opacity), slow, and respect prefers-reduced-motion (already handled globally). Keep paths short; prefer shapes over long hand-written paths.`,
}

/** The guide text for the requested modules (the core guide is always included). */
export function buildGuide(requested: unknown): string {
  const wanted = new Set<GuideModule>()
  const list = Array.isArray(requested) ? requested : []
  for (const m of list) {
    if (typeof m === 'string' && (GUIDE_MODULES as readonly string[]).includes(m)) {
      wanted.add(m as GuideModule)
    }
  }
  const parts = [CORE]
  for (const m of GUIDE_MODULES) if (wanted.has(m)) parts.push(MODULES[m])
  if (wanted.size === 0) {
    parts.push(
      `(No valid module requested. Available: ${GUIDE_MODULES.join(', ')}. Call again with the ones you need before drawing.)`
    )
  }
  return parts.join('\n\n')
}
