// Suppress the WebView2 "Reload site?" beforeunload confirmation.
// This desktop app has no page-level unsaved-form state worth guarding;
// the dialog only interrupts HMR reloads and extension operations.
Object.defineProperty(window, 'onbeforeunload', {
  get: function () { return null },
  set: function () {},
})
window.addEventListener('beforeunload', function (e) {
  e.stopImmediatePropagation()
  delete e.returnValue
}, true)
