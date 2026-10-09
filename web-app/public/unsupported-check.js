// Plain ES5 on purpose: when the system web view is too old to parse the app
// bundle, the module script never runs and the start-up screen would spin
// forever. This runs first and says what is wrong instead. Flint is built for
// browsers that support regex lookbehind (Safari 16.4, Chrome 111), which is
// also what the bundler targets.
(function () {
  var ok = true
  try {
    new RegExp('(?<=a)b')
    ok =
      typeof Object.hasOwn === 'function' &&
      typeof Array.prototype.at === 'function' &&
      typeof structuredClone === 'function'
  } catch (e) {
    ok = false
  }
  if (ok) return
  document.addEventListener('DOMContentLoaded', function () {
    var loader = document.getElementById('initial-loader')
    if (!loader) return
    loader.innerHTML =
      '<div class="fl-text" style="max-width:420px;text-align:center;padding:0 24px">' +
      '<p class="fl-name">Flint cannot run on this system</p>' +
      '<p id="initial-loader-caption">The web view built into your operating system is too old. ' +
      'On macOS, install the latest macOS and Safari updates available for your Mac; on Linux, update WebKitGTK; ' +
      'on Windows, update the Microsoft Edge WebView2 runtime.</p></div>'
  })
})()
