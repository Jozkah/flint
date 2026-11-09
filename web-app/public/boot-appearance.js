// Apply the theme, accent, font size and motion setting before first
// paint. The settings stores hydrate from the backend after boot, so
// they mirror their resolved values into localStorage 'flint-boot'
// (lib/bootAppearance.ts) for this script; keep the two in step.
// ThemeProvider re-resolves the real theme once React mounts.
(function () {
  var d = document.documentElement
  // A "New window" (lib/soloFlag) gets the quiet splash, not the brand one.
  if (location.search.indexOf('chatWindow') !== -1) d.classList.add('solo')
  var b = null
  try {
    b = JSON.parse(localStorage.getItem('flint-boot') || 'null')
  } catch (_) {}
  var t = (b && b.theme) || 'auto'
  // The Linux desktop app's webview (WebKitGTK) does not follow the desktop's
  // colour scheme: prefers-color-scheme reads light under a dark desktop. The
  // app resolves the real one from the XDG portal after boot, so a splash
  // painted from the media query flashes light first. There, trust the
  // resolved value the last run mirrored (b.dark) instead.
  var ua = navigator.userAgent
  var webkitGtk =
    !!window.__TAURI_INTERNALS__ &&
    /Linux/.test(ua) &&
    !/Android|Chrome|Chromium|Edg\//.test(ua)
  var dark =
    t === 'dark' ||
    (t === 'auto' &&
      (webkitGtk && b
        ? !!b.dark
        : window.matchMedia
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
  // The Linux desktop app applies the size as webview zoom once the app
  // loads (lib/interfaceScale.ts); a larger rem here would flash first.
  if (b.fontSize && !webkitGtk)
    d.style.setProperty('--font-size-base', b.fontSize)
  if (b.reduceMotion) d.classList.add('reduce-motion')
  if (b.increaseContrast) d.classList.add('high-contrast')
})()
