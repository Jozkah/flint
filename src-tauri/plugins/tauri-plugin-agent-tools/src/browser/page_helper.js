// Installed into the page being driven (idempotent). It reads the DOM into a
// compact outline and resolves the short refs (e1, e2, ...) the model uses.
// It runs with the page's own privileges and nothing more: no host access.
// `prefix` ("" for the first tab, "t2" for the second, ...) is part of every ref,
// so a ref says which tab it belongs to. Refs live in this document only, so a navigation drops them, which is how a
// stale ref is detected (the helper is gone, or the element is detached).
((prefix) => {
  const KEY = Symbol.for('flint.browser.v1');
  if (window[KEY]) return window[KEY];

  const refs = new Map(); // 'e3' -> WeakRef(element)
  const ids = new WeakMap(); // element -> 'e3'
  let next = 1;
  const MAX_NODES = 400;

  const clean = (s, n) => {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const refOf = (el) => {
    let id = ids.get(el);
    if (!id) {
      id = prefix + 'e' + next++;
      ids.set(el, id);
      refs.set(id, new WeakRef(el));
    }
    return id;
  };
  const get = (ref) => {
    const w = refs.get(ref);
    const el = w && w.deref();
    return el && el.isConnected ? el : null;
  };
  const rendered = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'contents') return true;
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return el.getClientRects().length > 0;
  };
  const labelOf = (el) => {
    const a = el.getAttribute('aria-label');
    if (a && a.trim()) return a;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((i) => (document.getElementById(i) || {}).textContent || '').join(' ');
      if (t.trim()) return t;
    }
    if (el.labels && el.labels.length) {
      const t = [...el.labels].map((l) => l.textContent).join(' ');
      if (t.trim()) return t;
    }
    const tag = el.tagName;
    if (tag === 'IMG') return el.getAttribute('alt') || '';
    if (tag === 'INPUT') {
      const ty = (el.type || '').toLowerCase();
      if (ty === 'submit' || ty === 'button' || ty === 'reset') return el.value || ty;
      return el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '';
    }
    if (tag === 'TEXTAREA' || tag === 'SELECT') return el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '';
    const inner = el.innerText || el.textContent || '';
    return inner.trim() ? inner : el.getAttribute('title') || '';
  };
  const WIDGETS = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'option', 'treeitem', 'filebutton', 'clickable']);
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    switch (el.tagName) {
      case 'A': return el.hasAttribute('href') ? 'link' : null;
      case 'BUTTON': case 'SUMMARY': return 'button';
      case 'SELECT': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'TEXTAREA': return 'textbox';
      case 'INPUT': {
        const ty = (el.type || 'text').toLowerCase();
        if (ty === 'hidden') return null;
        if (['submit', 'button', 'reset', 'image'].includes(ty)) return 'button';
        if (ty === 'checkbox') return 'checkbox';
        if (ty === 'radio') return 'radio';
        if (ty === 'range') return 'slider';
        if (ty === 'number') return 'spinbutton';
        if (ty === 'search') return 'searchbox';
        if (ty === 'file') return 'filebutton';
        return 'textbox';
      }
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
      case 'NAV': return 'navigation';
      case 'MAIN': return 'main';
      case 'FORM': return el.getAttribute('aria-label') || el.getAttribute('name') ? 'form' : null;
      case 'DIALOG': return 'dialog';
      case 'IMG': return el.getAttribute('alt') ? 'img' : null;
      case 'IFRAME': return 'iframe';
      default: break;
    }
    const ce = el.getAttribute('contenteditable');
    if (ce === '' || ce === 'true' || ce === 'plaintext-only') return 'textbox';
    if (el.hasAttribute('onclick') || (el.tabIndex >= 0 && el.hasAttribute('tabindex'))) return 'clickable';
    return null;
  };
  const stateOf = (el, role) => {
    const s = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if (el.checked === true || el.getAttribute('aria-checked') === 'true') s.push('checked');
    if (el.getAttribute('aria-checked') === 'mixed') s.push('mixed');
    if (el.getAttribute('aria-expanded') === 'true') s.push('expanded');
    if (el.getAttribute('aria-expanded') === 'false') s.push('collapsed');
    if (el.getAttribute('aria-selected') === 'true') s.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') s.push('pressed');
    if (el.required || el.getAttribute('aria-required') === 'true') s.push('required');
    if (el.readOnly) s.push('readonly');
    if (el.validity && !el.validity.valid && el.willValidate && role !== 'button') s.push('invalid');
    if (document.activeElement === el) s.push('focused');
    return s;
  };
  const valueOf = (el, role) => {
    const ty = (el.type || '').toLowerCase();
    if (el.tagName === 'INPUT' && ty === 'password') return el.value ? '(hidden, ' + el.value.length + ' chars)' : '';
    if (el.tagName === 'SELECT') {
      return [...el.selectedOptions].map((o) => clean(o.textContent, 60)).join(', ');
    }
    if (role === 'textbox' || role === 'searchbox' || role === 'slider' || role === 'spinbutton') {
      if (typeof el.value === 'string') return clean(el.value, 120);
      return clean(el.textContent, 120);
    }
    return '';
  };
  const describe = (el) => {
    const t = el.localName;
    const id = el.id ? '#' + el.id : '';
    const txt = clean(el.innerText || el.getAttribute('aria-label') || '', 40);
    return '<' + t + id + '>' + (txt ? ' "' + txt + '"' : '');
  };

  const walk = (children, depth, out) => {
    for (const el of children) {
      if (el.nodeType !== 1) continue;
      if (out.nodes.length >= MAX_NODES) { out.truncated++; continue; }
      const tag = el.localName;
      if (['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'svg', 'canvas', 'option', 'optgroup'].includes(tag)) continue;
      if (el.getAttribute('aria-hidden') === 'true' || el.hidden) continue;
      if (!rendered(el)) continue;
      const role = roleOf(el);
      if (role && WIDGETS.has(role)) {
        const node = { ref: refOf(el), role, name: clean(labelOf(el), 80), depth };
        const st = stateOf(el, role);
        if (st.length) node.states = st;
        const v = valueOf(el, role);
        if (v) node.value = v;
        if (tag === 'a' && el.getAttribute('href')) node.href = clean(el.getAttribute('href'), 100);
        if (tag === 'select') node.options = [...el.options].slice(0, 12).map((o) => clean(o.textContent, 40));
        out.nodes.push(node);
        continue;
      }
      if (role === 'heading') {
        out.nodes.push({ role, name: clean(el.innerText, 100), level: Number(tag[1]) || 0, depth });
        continue;
      }
      if (role === 'img') { out.nodes.push({ role, name: clean(el.getAttribute('alt'), 80), depth }); continue; }
      if (role === 'iframe') { out.nodes.push({ role, name: clean(el.title || el.getAttribute('src'), 80), depth }); continue; }
      if (role) {
        const label = clean(el.getAttribute('aria-label') || el.getAttribute('name') || '', 60);
        out.nodes.push({ role, name: label, depth });
        walkInto(el, depth + 1, out);
        continue;
      }
      let own = '';
      for (const c of el.childNodes) if (c.nodeType === 3) own += c.nodeValue + ' ';
      own = clean(own, 160);
      if (own && !(tag === 'label' && el.control)) out.nodes.push({ role: 'text', name: own, depth });
      walkInto(el, depth, out);
    }
  };
  const walkInto = (el, depth, out) => {
    if (el.shadowRoot) walk(el.shadowRoot.children, depth, out);
    walk(el.children, depth, out);
  };

  const snapshot = (rootRef) => {
    const out = { nodes: [], truncated: 0 };
    if (rootRef) {
      const el = get(rootRef);
      if (!el) return { stale: true };
      walk([el], 0, out);
    } else {
      walk(document.body ? [document.body] : [], 0, out);
    }
    const de = document.documentElement;
    return {
      url: location.href,
      title: document.title,
      scroll: { x: Math.round(scrollX), y: Math.round(scrollY), w: de.scrollWidth, h: de.scrollHeight, vw: innerWidth, vh: innerHeight },
      nodes: out.nodes,
      truncated: out.truncated,
    };
  };

  const locate = (ref) => {
    let el = get(ref);
    if (!el) return { stale: true };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    let r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && el.labels && el.labels[0]) {
      // A visually hidden checkbox/radio is clicked through its label.
      r = el.labels[0].getBoundingClientRect();
    }
    if (r.width === 0 && r.height === 0) return { hidden: true };
    const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    const top = document.elementFromPoint(x, y);
    let covered = null;
    if (top && top !== el && !el.contains(top) && !top.contains(el) && !(el.labels && [...el.labels].some((l) => l === top || l.contains(top)))) {
      covered = describe(top);
    }
    const role = roleOf(el);
    return { x, y, tag: el.localName, role, name: clean(labelOf(el), 60), disabled: !!el.disabled, covered };
  };

  const rectOf = (ref) => {
    const el = get(ref);
    if (!el) return { stale: true };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { hidden: true };
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  };

  const setNative = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // Focus a text field for typing. Returns what to do next.
  const focusField = (ref, clear, text) => {
    const el = get(ref);
    if (!el) return { stale: true };
    const ce = el.getAttribute('contenteditable');
    const editableDiv = ce === '' || ce === 'true' || ce === 'plaintext-only';
    const ty = (el.type || 'text').toLowerCase();
    const textual = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden'].includes(ty));
    if (!textual && !editableDiv) return { notField: true, tag: el.localName, role: roleOf(el) };
    if (el.disabled || el.readOnly) return { disabled: true };
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (clear && text === '' && textual) { setNative(el, ''); return { done: true, tag: el.localName }; }
    if (clear) {
      if (typeof el.select === 'function') el.select();
      else if (editableDiv) getSelection().selectAllChildren(el);
    } else if (typeof el.setSelectionRange === 'function') {
      try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* number fields */ }
    } else if (editableDiv) {
      const s = getSelection();
      s.selectAllChildren(el);
      s.collapseToEnd();
    }
    return { tag: el.localName };
  };

  const choose = (ref, value) => {
    const el = get(ref);
    if (!el) return { stale: true };
    if (el.tagName !== 'SELECT') return { notSelect: true, tag: el.localName };
    const opts = [...el.options];
    const want = String(value).trim();
    const lower = want.toLowerCase();
    const hit =
      opts.find((o) => o.value === want) ||
      opts.find((o) => o.textContent.trim() === want) ||
      opts.find((o) => o.textContent.trim().toLowerCase() === lower);
    if (!hit) return { missing: true, options: opts.slice(0, 20).map((o) => clean(o.textContent, 40)) };
    if (hit.disabled) return { optionDisabled: true };
    if (el.multiple) hit.selected = true; else el.selectedIndex = hit.index;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { chosen: clean(hit.textContent, 60), value: hit.value };
  };

  const pos = () => {
    const de = document.documentElement;
    return { x: Math.round(scrollX), y: Math.round(scrollY), w: de.scrollWidth, h: de.scrollHeight, vw: innerWidth, vh: innerHeight };
  };
  const scrollBy = (dx, dy) => {
    const bx = scrollX, by = scrollY;
    window.scrollBy(dx, dy);
    let container = null;
    if (scrollX === bx && scrollY === by) {
      // The page itself does not scroll: an app shell with its own scroller.
      let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      while (el && el !== document.body && el !== document.documentElement) {
        const cs = getComputedStyle(el);
        const can = (dy && /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) || (dx && /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth);
        if (can) { el.scrollBy(dx, dy); container = describe(el); break; }
        el = el.parentElement;
      }
    }
    return { ...pos(), container };
  };
  const scrollTo = (ref) => {
    const el = get(ref);
    if (!el) return { stale: true };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    return pos();
  };

  const hasText = (t) => !!document.body && document.body.innerText.includes(t);
  const hasSelector = (s) => {
    let el;
    try { el = document.querySelector(s); } catch (e) { return { bad: String(e.message || e) }; }
    return !!el && rendered(el);
  };
  const meta = () => ({ url: location.href, title: document.title, ready: document.readyState });

  const focus = (ref) => {
    const el = get(ref);
    if (!el) return { stale: true };
    el.scrollIntoView({ block: 'center' });
    el.focus();
    return { ok: true, tag: el.localName };
  };

  // What an upload needs to know before the browser attaches a file.
  const fileCheck = (ref) => {
    const el = get(ref);
    if (!el) return { stale: true };
    if (el.tagName !== 'INPUT' || (el.type || '').toLowerCase() !== 'file') return { notFile: true, role: roleOf(el) || el.localName };
    if (el.disabled) return { disabled: true };
    return { ok: true, multiple: !!el.multiple, accept: el.accept || '' };
  };
  const element = (ref) => get(ref);

  const api = { snapshot, locate, rectOf, focusField, choose, scrollBy, scrollTo, hasText, hasSelector, meta, pos, focus, fileCheck, element };
  Object.defineProperty(window, KEY, { value: api, enumerable: false, configurable: true });
  return api;
})
