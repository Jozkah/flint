import { CDN_HOSTS } from './constants'

/**
 * The iframe a widget runs in. No `allow-same-origin`: the document gets an
 * opaque origin, so it cannot read the app's DOM, storage, cookies or IPC.
 */
export const WIDGET_SANDBOX = 'allow-scripts'

/**
 * The policy a widget document carries (as a meta tag and, in the desktop app,
 * the `flintpreview:` response header; the browser applies both, so the
 * narrower one wins). Nothing loads from the network except, when the user
 * allowed it, scripts from two named CDNs.
 */
export function widgetCsp(allowCdn: boolean): string {
  const scripts = ["'unsafe-inline'", ...(allowCdn ? CDN_HOSTS : [])].join(' ')
  return [
    "default-src 'none'",
    `script-src ${scripts}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
}

/** Base styles: unstyled HTML should already look like the rest of the app. */
const BASE_CSS = `
:root{color-scheme:light}
:root[data-theme=dark]{color-scheme:dark}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent}
body{color:var(--foreground);font:14px/1.5 var(--font-sans,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);-webkit-font-smoothing:antialiased}
#flint-root{display:flow-root;padding:14px 16px;visibility:hidden}
[hidden]{display:none!important}
h1,h2,h3,h4{margin:0 0 .45em;font-weight:600;line-height:1.3;color:var(--foreground)}
h1{font-size:18px}h2{font-size:15.5px}h3{font-size:13.5px}h4{font-size:12.5px;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.04em}
p{margin:0 0 .6em}
a{color:var(--info);text-decoration:none}a:hover{text-decoration:underline}
small,.muted{color:var(--muted-foreground)}
small{font-size:12px}
hr{border:0;border-top:1px solid var(--border);margin:12px 0}
code,kbd,pre,samp{font-family:var(--font-mono,ui-monospace,Consolas,monospace);font-size:12.5px}
code{background:var(--muted);border:1px solid var(--border);border-radius:4px;padding:0 4px}
pre{background:var(--muted);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;overflow:auto;margin:0 0 .6em}
pre code{background:none;border:0;padding:0}
button,select,input,textarea{font:inherit;color:var(--foreground)}
button{background:var(--card);border:1px solid var(--border-strong);border-radius:var(--radius-sm,6px);padding:4px 12px;cursor:pointer;line-height:1.4}
button:hover{background:var(--accent)}
button:active{transform:translateY(.5px)}
button:disabled{opacity:.5;cursor:default}
button.primary,.btn-primary{background:var(--primary);color:var(--primary-foreground);border-color:transparent}
button.primary:hover{background:var(--primary-hover,var(--primary));opacity:.92}
input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),select,textarea{background:var(--background);border:1px solid var(--border-strong);border-radius:var(--radius-sm,6px);padding:4px 8px;min-width:0}
input[type=range]{accent-color:var(--primary);width:100%}
input[type=checkbox],input[type=radio]{accent-color:var(--primary)}
:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
input.toggle{appearance:none;-webkit-appearance:none;flex:none;width:32px;height:18px;border-radius:9px;background:var(--track);border:1px solid var(--border-strong);position:relative;cursor:pointer;transition:background .15s;margin:0}
input.toggle::after{content:"";position:absolute;top:1px;left:1px;width:14px;height:14px;border-radius:50%;background:var(--knob);box-shadow:0 1px 2px rgba(0,0,0,.35);transition:transform .15s}
input.toggle:checked{background:var(--primary);border-color:transparent}
input.toggle:checked::after{transform:translateX(14px);background:var(--primary-foreground)}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left}
th{color:var(--muted-foreground);font-weight:500;font-size:12px}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px}
.row{display:flex;align-items:center;gap:8px}
.between{justify-content:space-between}
.wrap{flex-wrap:wrap}
.stack{display:flex;flex-direction:column;gap:8px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr))}
.badge{display:inline-flex;align-items:center;gap:4px;padding:0 6px;border:1px solid var(--border-strong);border-radius:4px;font-size:10.5px;line-height:16px;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.03em}
.ok{color:var(--success)}.warn{color:var(--warning)}.err{color:var(--destructive)}
.list>*{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--border)}
.list>*:last-child{border-bottom:0}
svg{max-width:100%;height:auto;overflow:visible}
svg text{font-family:var(--font-sans,system-ui,sans-serif);fill:var(--foreground);font-size:12px}
img,canvas,video{max-width:100%}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`

/**
 * Runs first in every widget document. It is trusted only to cooperate: the
 * widget's own code shares its realm and can replace anything here, so the
 * host never relies on it for security (it re-checks every message it gets).
 *
 * Messages in (from the host): `theme` (CSS variables), `content` (the markup,
 * activated once `final`). Messages out: `ready`, `height`, `error`,
 * `sendPrompt`, `openLink`, and a `beat` every second that the host watches:
 * a script stuck in a loop stops sending it.
 */
const PRELUDE = `
(function(){
var P=window.parent,root=document.getElementById('flint-root'),themed=false,lastH=-1,errs=0,act=0;
function post(m){m.flint=1;try{P.postMessage(m,'*')}catch(e){}}
function fail(msg){if(errs++<3)post({op:'error',message:String(msg).slice(0,300)})}
function report(){var h=Math.ceil(root.getBoundingClientRect().height);if(h!==lastH){lastH=h;post({op:'height',h:h})}}
try{new ResizeObserver(report).observe(root)}catch(e){}
addEventListener('resize',report);
addEventListener('error',function(e){if(e.target&&e.target!==window)return;fail(e.message||'Script error')});
addEventListener('unhandledrejection',function(e){var r=e.reason;fail('Unhandled rejection: '+(r&&r.message||r))});
document.addEventListener('securitypolicyviolation',function(e){fail('Blocked by the widget security policy: '+e.violatedDirective+' '+(e.blockedURI||''))});
['pointerdown','keydown','click'].forEach(function(t){addEventListener(t,function(e){if(e.isTrusted)act=Date.now()},true)});
document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href')||'';e.preventDefault();
if(h.charAt(0)==='#'){var t=document.getElementById(h.slice(1));if(t)t.scrollIntoView();return}
if(/^https?:/i.test(h))post({op:'openLink',url:a.href})},true);
window.flint=Object.freeze({
sendPrompt:function(t){if(typeof t!=='string'||!t.trim()||Date.now()-act>5000)return;post({op:'sendPrompt',text:t})},
openLink:function(u){if(typeof u==='string'&&Date.now()-act<=5000)post({op:'openLink',url:u})}
});
function theme(d){var s=document.documentElement.style,v=d.vars||{};for(var k in v){if(/^--[a-z0-9-]+$/.test(k))s.setProperty(k,String(v[k]))}
document.documentElement.setAttribute('data-theme',d.dark?'dark':'light');
if(!themed){themed=true;root.style.visibility='visible'}report()}
function activate(){var olds=[].slice.call(root.querySelectorAll('script')),chain=Promise.resolve();
olds.forEach(function(o){chain=chain.then(function(){return new Promise(function(res){
var n=document.createElement('script'),ext=!!o.getAttribute('src');
for(var i=0;i<o.attributes.length;i++)n.setAttribute(o.attributes[i].name,o.attributes[i].value);
if(ext){n.async=false;n.onload=function(){res()};n.onerror=function(){fail('Could not load script '+o.getAttribute('src'));res()}}else n.textContent=o.textContent;
o.parentNode.replaceChild(n,o);if(!ext)res()})})});
chain.then(function(){try{document.dispatchEvent(new Event('DOMContentLoaded',{bubbles:true}));window.dispatchEvent(new Event('load'))}catch(e){fail(e.message)}report()})}
addEventListener('message',function(e){if(e.source!==P)return;var d=e.data;if(!d||d.flint!==1)return;
if(d.op==='theme')theme(d);
else if(d.op==='content'&&typeof d.html==='string'){root.innerHTML=d.html;if(d.final)activate();report()}});
setInterval(function(){post({op:'beat'})},1000);
post({op:'ready'});
})();
`

/**
 * The document every widget runs in. Constant for a given policy: the widget's
 * markup and the theme arrive by message, so a streamed widget never reloads
 * the frame (a reload would restart its scripts and flash).
 */
export function buildWidgetShell(allowCdn: boolean): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${widgetCsp(allowCdn)}">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<style>${BASE_CSS}</style></head>` +
    `<body><div id="flint-root"></div><script>${PRELUDE}</script></body></html>`
  )
}

/**
 * The same widget as one standalone page, for "save as file" and
 * "copy HTML": the theme at the time it was saved, scripts in place.
 */
export function buildStandalonePage(
  title: string,
  code: string,
  vars: Record<string, string>,
  dark: boolean
): string {
  const css = Object.entries(vars)
    .filter(([k]) => /^--[a-z0-9-]+$/.test(k))
    .map(([k, v]) => `${k}:${v.replace(/[<>{};]/g, '')}`)
    .join(';')
  const safeTitle = title.replace(/[<>&"]/g, '')
  return (
    '<!doctype html><html data-theme="' +
    (dark ? 'dark' : 'light') +
    `"><head><meta charset="utf-8"><title>${safeTitle}</title>` +
    `<style>:root{${css}}${BASE_CSS}#flint-root{visibility:visible}</style></head>` +
    `<body><div id="flint-root">${code}</div></body></html>`
  )
}

export type FrameMessage =
  | { op: 'ready' }
  | { op: 'beat' }
  | { op: 'height'; h: number }
  | { op: 'error'; message: string }
  | { op: 'sendPrompt'; text: string }
  | { op: 'openLink'; url: string }

/** A message from a widget frame, or null when it is not one of ours. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!data || typeof data !== 'object') return null
  const m = data as Record<string, unknown>
  if (m.flint !== 1) return null
  switch (m.op) {
    case 'ready':
      return { op: 'ready' }
    case 'beat':
      return { op: 'beat' }
    case 'height':
      return typeof m.h === 'number' && Number.isFinite(m.h)
        ? { op: 'height', h: m.h }
        : null
    case 'error':
      return typeof m.message === 'string'
        ? { op: 'error', message: m.message.slice(0, 300) }
        : null
    case 'sendPrompt':
      return typeof m.text === 'string' ? { op: 'sendPrompt', text: m.text } : null
    case 'openLink':
      return typeof m.url === 'string' ? { op: 'openLink', url: m.url } : null
    default:
      return null
  }
}
