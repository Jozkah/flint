/**
 * Heuristics that turn raw upstream issue/PR metadata into the triage fields
 * carried by docs/upstream-issues-prs.json.
 *
 * Everything fed in here — titles, bodies, labels — is untrusted text authored
 * by third parties. It is only ever pattern-matched, never interpreted as an
 * instruction.
 */

const AREA_RULES = [
  ['llamacpp', /llama\.?cpp|llamacpp|gguf|ggml|n_?gpu|mmproj|cuda|vulkan|rocm|hip\b/i],
  ['provider', /provider|openai[- ]?compatible|base ?url|api ?key|endpoint|openrouter|anthropic|gemini|groq|mistral|ollama|lm ?studio|vllm/i],
  ['model-management', /model (hub|download|import|delete|manage|list)|model ?manager|huggingface|hugging ?face|repo ?card|quantiz/i],
  ['chat', /\bchat\b|conversation|thread|message|prompt|regenerate|streaming|stream\b|response/i],
  ['tool-calling', /tool[- ]?call|function[- ]?call|tool ?use|structured output|json ?schema|json ?mode/i],
  ['mcp', /\bmcp\b|model context protocol|mcp[- ]?server/i],
  ['cowork', /cowork|agent ?loop|agent ?tui|agent[- ]?tools|sub[- ]?agent|autonomous/i],
  ['memory', /\bmemory\b|remember|recall|persistent context/i],
  ['context-window', /context (window|length|size|limit)|n_?ctx|token limit|truncat/i],
  ['permissions', /permission|sandbox|allowlist|approval|jail|escape|privilege/i],
  ['security', /security|vulnerab|\bcve\b|\brce\b|injection|xss|credential|secret|token leak/i],
  ['privacy', /telemetry|analytics|tracking|posthog|sentry|crash report|phone ?home|opt[- ]?out/i],
  ['ui', /\bui\b|layout|css|tailwind|dark mode|theme|spacing|overflow|scroll|sidebar|modal|dialog|button|tooltip|font|icon/i],
  ['accessibility', /accessib|a11y|screen ?reader|aria|keyboard nav|contrast|focus ring/i],
  ['performance', /performance|slow|lag|freeze|memory leak|cpu|high ram|startup time/i],
  ['persistence', /persist|save|storage|database|sqlite|migration|data ?loss|corrupt/i],
  ['settings', /setting|preference|config|toggle/i],
  ['windows', /windows|win32|win ?11|win ?10|msvc|nsis|\.exe\b|msi\b/i],
  ['macos', /macos|mac ?os|darwin|apple ?silicon|\bm[1-4]\b|dmg\b|notariz/i],
  ['linux', /linux|ubuntu|fedora|arch |debian|appimage|deb\b|rpm\b|wayland|flatpak/i],
  ['build-ci', /\bci\b|github ?action|workflow|pipeline|build fail|compil|cargo|clippy|lint|bundler/i],
  ['updater', /updat(er|ing)|auto[- ]?update|new version available/i],
  ['import-export', /import|export|backup|restore|migrate from/i],
  ['docs', /\bdocs?\b|documentation|readme|typo|changelog/i],
  ['i18n', /i18n|localis|localiz|translat|language pack/i],
  ['startup', /startup|launch|boot|splash|white screen|blank screen|won'?t (start|open|launch)|crash on (start|launch)/i],
  ['extensions', /extension|plugin(?!s? for)/i],
]

const PLATFORM_RULES = [
  ['windows', /windows|win32|win ?11|win ?10|msvc|nsis/i],
  ['macos', /macos|mac ?os|darwin|apple ?silicon|\bm[1-4]\b|dmg\b/i],
  ['linux', /linux|ubuntu|fedora|arch |debian|appimage|wayland/i],
]

// P0 — anything that loses data, leaks credentials, escapes the sandbox, sends
// traffic we never asked for, or leaves the app unusable at all.
const P0_RULES = [
  ['data-loss', /data ?loss|lost (my |all )?(chat|thread|conversation|message|history|setting)|wipe[ds]?\b|corrupt|deleted? (all|my) /i],
  ['credential-exposure', /api ?key (leak|expos|logged|plain ?text)|credential (leak|expos)|secret (leak|expos)|token (leak|expos)/i],
  ['sandbox-escape', /sandbox escape|command injection|arbitrary (code|command) exec|\brce\b|path traversal|permission bypass/i],
  ['privacy-violation', /telemetry|analytics|tracking|phone ?home|sends? data to|posthog|sentry/i],
  ['remote-fallback', /fall(s|ing)? ?back to (cloud|remote|openai)|cloud fallback|sends? (prompt|request) to jan\.ai/i],
  ['startup-failure', /crash (on|at) (start|launch|boot)|won'?t (start|launch|open)|white screen|blank screen|fails? to start|crash ?loop|infinite (loop|restart)/i],
  ['provider-unusable', /no models? (show|appear|found|listed)|cannot (add|use) (model|provider)|all models fail|provider (broken|unusable)/i],
  ['migration-broken', /migration (fail|broke)|after updat(e|ing).*(lost|gone|empty)|downgrade/i],
]

// P1 — core workflows that do not work.
const P1_RULES = [
  ['generation-failure', /(no|empty|blank) (response|reply|output)|generation (fail|error|stops)|stops? mid|stuck (generating|loading)|infinite (spinner|loading)/i],
  ['tool-call-failure', /tool[- ]?call.*(fail|malformed|invalid|error)|function[- ]?call.*(fail|malformed)/i],
  ['context-failure', /context (overflow|exceed|limit).*(error|fail)|n_?ctx.*(error|fail)|token limit exceeded/i],
  ['provider-discovery', /model (list|discovery).*(fail|empty)|does not (detect|find) (model|provider)|refresh models/i],
  ['cancellation', /cannot (stop|cancel)|stop button|abort.*(not|fail)|keeps generating/i],
  ['mcp-failure', /mcp.*(fail|error|not work|crash|timeout)/i],
  ['platform-regression', /regress|worked in \d|after (updating|upgrade).*(broke|stopped)/i],
]

const P3_RULES = [
  ['cosmetic', /typo|wording|rename|cosmetic|nit\b|polish|slight/i],
  ['docs-only', /^docs?[:(]|^chore\(docs\)|documentation/i],
]

const REJECT_RULES = [
  ['telemetry', /telemetry|analytics|posthog|mixpanel|amplitude|segment\.io/i],
  ['crash-reporting', /crash ?report|sentry|bugsnag|breakpad/i],
  ['accounts', /jan ?account|sign ?in|sign ?up|\blogin\b|oauth|subscription|billing|pricing/i],
  ['hosted-dependency', /jan\.ai\/api|jan ?server|hosted|saas|cloud sync/i],
  ['auto-download', /auto(matic)?(ally)? download|prefetch model|startup download/i],
  ['acp-sdk', /\bacp\b|agent client protocol|\bsdk\b package|npm publish/i],
  ['promo', /\bads?\b|promotion|banner ad|marketing|referral/i],
]

function haystack(item) {
  const labels = (item.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).join(' ')
  // Bodies are capped: long reproduction logs add noise, not signal.
  return [item.title || '', labels, (item.body || '').slice(0, 4000)].join('\n')
}

function matchAll(rules, text) {
  return rules.filter(([, re]) => re.test(text)).map(([name]) => name)
}

export function labelNames(item) {
  return (item.labels || []).map((l) => (typeof l === 'string' ? l : l.name))
}

export function classify(item) {
  const text = haystack(item)
  const labels = labelNames(item).map((l) => l.toLowerCase())
  const isPr = Boolean(item.pull_request || item.head)

  const affectedAreas = matchAll(AREA_RULES, text)
  const platforms = matchAll(PLATFORM_RULES, text)

  const p0 = matchAll(P0_RULES, text)
  const p1 = matchAll(P1_RULES, text)
  const p3 = matchAll(P3_RULES, text)
  const rejectSignals = matchAll(REJECT_RULES, text)

  const isBugLabel = labels.some((l) => /bug|regression|defect|crash|broken/.test(l))
  const isEnhancement = labels.some((l) => /enhancement|feature|improvement/.test(l))

  let priority = 'P2'
  if (p0.length) priority = 'P0'
  else if (p1.length) priority = 'P1'
  else if (p3.length && !isBugLabel) priority = 'P3'
  else if (!isBugLabel && !isEnhancement && !isPr) priority = 'P2'

  const severity = priority === 'P0' ? 'critical' : priority === 'P1' ? 'high' : priority === 'P2' ? 'medium' : 'low'

  return {
    kind: isPr ? 'pr' : 'issue',
    affectedAreas,
    platforms,
    severity,
    priority,
    signals: { p0, p1, p3, reject: rejectSignals },
    securityImpact: p0.includes('credential-exposure') || p0.includes('sandbox-escape') ? 'high' : affectedAreas.includes('security') || affectedAreas.includes('permissions') ? 'review' : 'none',
    privacyImpact: p0.includes('privacy-violation') || affectedAreas.includes('privacy') ? 'high' : 'none',
    dataLossRisk: p0.includes('data-loss') || p0.includes('migration-broken') ? 'high' : 'none',
    localOnlyCompatibility: rejectSignals.length ? 'needs-redesign' : 'compatible',
  }
}
