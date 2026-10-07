// Apply the theme, accent, font size and motion setting before first
// paint. The settings stores hydrate from the backend after boot, so
// they mirror their resolved values into localStorage 'flint-boot'
// (lib/bootAppearance.ts) for this script; keep the two in step.
// ThemeProvider re-resolves the real theme once React mounts.
(function () {
  var d = document.documentElement
  var b = null
  try {
    b = JSON.parse(localStorage.getItem('flint-boot') || 'null')
  } catch (_) {}
  var t = (b && b.theme) || 'auto'
  var dark =
    t === 'dark' ||
    (t === 'auto' &&
      (window.matchMedia
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : !!(b && b.dark)))
  if (dark) d.classList.add('dark')
  d.style.colorScheme = dark ? 'dark' : 'light'
  d.style.background = dark ? '#0a0b0d' : '#f8f8f8'
  if (!b) return
  var vars = b.vars && b.vars[dark ? 'dark' : 'light']
  if (vars)
    for (var k in vars)
      if (Object.prototype.hasOwnProperty.call(vars, k))
        d.style.setProperty(k, vars[k])
  if (b.fontSize) d.style.setProperty('--font-size-base', b.fontSize)
  if (b.reduceMotion) d.classList.add('reduce-motion')
})()
