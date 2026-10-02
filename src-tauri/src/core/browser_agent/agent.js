// Runs inside the agent's browser pane. Synchronous on purpose: the host reads
// the value this function returns (a promise would not be awaited).
//
// Called as (function (KEY, OP, ARGS) {...})(key, op, args), with all three
// substituted as JSON literals by the host. KEY names a hidden, non-enumerable
// property on window that holds the snapshot state; it changes every app start.
//
// Nothing here trusts the page: the page can read and change everything this
// script touches. What it returns is therefore treated as untrusted text by
// the host, and every decision that matters (which domains, which actions, how
// many) is made on the host side.
(function (KEY, OP, ARGS) {
  'use strict';
  var MAX_NODES = 700;
  var MAX_LINES = 1600;
  var MAX_CHARS = 60000;

  function fail(code, message, extra) {
    var r = { ok: false, code: code, error: message };
    if (extra) for (var k in extra) r[k] = extra[k];
    return r;
  }

  try {
    var S = window[KEY];
    if (!S) {
      S = { gen: 0, map: new Map() };
      Object.defineProperty(window, KEY, {
        value: S,
        enumerable: false,
        configurable: true,
      });
    }

    function clip(s, n) {
      s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
      return s.length > n ? s.slice(0, n - 1) + '…' : s;
    }

    function visible(el) {
      if (el.hidden) return false;
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
      try {
        if (el.checkVisibility) {
          return el.checkVisibility({ visibilityProperty: true });
        }
        var cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
      } catch (e) {
        return true;
      }
    }

    function sensitiveField(el) {
      if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
      var type = (el.type || '').toLowerCase();
      if (type === 'password') return true;
      var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      return (
        ac.indexOf('cc-') !== -1 ||
        ac.indexOf('password') !== -1 ||
        ac.indexOf('one-time-code') !== -1
      );
    }

    function labelOf(el) {
      var v = el.getAttribute && el.getAttribute('aria-label');
      if (v) return clip(v, 100);
      var by = el.getAttribute && el.getAttribute('aria-labelledby');
      if (by) {
        var t = by
          .split(/\s+/)
          .map(function (id) {
            var n = document.getElementById(id);
            return n ? n.textContent : '';
          })
          .join(' ');
        if (t.trim()) return clip(t, 100);
      }
      if (el.labels && el.labels.length) {
        return clip(
          Array.prototype.map
            .call(el.labels, function (l) {
              return l.textContent;
            })
            .join(' '),
          100
        );
      }
      var alt = el.getAttribute && el.getAttribute('alt');
      if (alt) return clip(alt, 100);
      var ph = el.getAttribute && el.getAttribute('placeholder');
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        var type = (el.type || '').toLowerCase();
        if ((type === 'submit' || type === 'button' || type === 'reset') && el.value) {
          return clip(el.value, 100);
        }
        if (ph) return clip(ph, 100);
        var nm = el.getAttribute('name');
        if (nm) return clip(nm, 100);
      }
      var text = clip(el.textContent, 100);
      if (text) return text;
      var title = el.getAttribute && el.getAttribute('title');
      if (title) return clip(title, 100);
      return '';
    }

    var INTERACTIVE_ROLES = {
      button: 1, link: 1, checkbox: 1, radio: 1, menuitem: 1, tab: 1, switch: 1,
      option: 1, combobox: 1, textbox: 1, searchbox: 1, slider: 1, menuitemcheckbox: 1,
      menuitemradio: 1, treeitem: 1,
    };

    function roleOf(el) {
      var explicit = el.getAttribute && el.getAttribute('role');
      if (explicit) return explicit.split(/\s+/)[0].toLowerCase();
      var tag = el.tagName;
      if (tag === 'A') return el.hasAttribute('href') ? 'link' : '';
      if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
      if (tag === 'SELECT') return 'combobox';
      if (tag === 'TEXTAREA') return 'textbox';
      if (tag === 'INPUT') {
        var type = (el.type || 'text').toLowerCase();
        if (type === 'hidden') return '';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
        if (type === 'range') return 'slider';
        if (type === 'search') return 'searchbox';
        return 'textbox';
      }
      if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox';
      return '';
    }

    var STRUCTURE = {
      NAV: 'navigation', MAIN: 'main', FORM: 'form', UL: 'list', OL: 'list',
      TABLE: 'table', DIALOG: 'dialog', ASIDE: 'complementary', HEADER: 'banner',
      FOOTER: 'contentinfo', ARTICLE: 'article', SECTION: '', FIELDSET: 'group',
    };

    function ownText(el) {
      var out = '';
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out += c.nodeValue + ' ';
      }
      return clip(out, 160);
    }

    // ---- the pointer -------------------------------------------------------
    //
    // A visible mouse for the assistant: an arrow with an outline and glow that
    // glides to what it is about to act on, pulses on a click and fades a few
    // seconds after the last action. Purely cosmetic and purely additive:
    //   - it lives in a closed shadow root under a zero-size fixed host on the
    //     document element (not the body), so read_text, the snapshot and the
    //     node ids never see it and it cannot move the page's layout or scroll;
    //   - the host's tag and id are random, and it is removed on navigation (the
    //     document goes), on `remove`, and after it fades;
    //   - nothing waits on it here: the host sleeps for the `wait` an op returns,
    //     and every safety decision was made before any op that moves it.
    var GLIDE_MIN = 250;
    var GLIDE_MAX = 650;
    var SCROLL_MS = 250;
    var FADE_AFTER_MS = 3000;
    var FADE_MS = 400;

    function prefersReduced() {
      try {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch (e) {
        return false;
      }
    }

    /** `show`: draw it. `reduce`: no glide, no pulse (null follows the system). */
    function pointerOpts() {
      var p = ARGS.pointer || {};
      return {
        show: p.show !== false,
        reduce: p.reduce === true || (p.reduce == null && prefersReduced()),
      };
    }

    function now() {
      return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    }

    function rand() {
      return Math.random().toString(36).slice(2, 10);
    }

    var CURSOR_CSS =
      ':host{all:initial}' +
      '.c{position:fixed;left:0;top:0;pointer-events:none;will-change:transform;transition:opacity .4s ease}' +
      '.c svg{display:block;overflow:visible;filter:drop-shadow(0 0 3px rgba(124,92,255,.9)) drop-shadow(0 0 9px rgba(124,92,255,.55))}' +
      '.l{position:absolute;left:16px;top:18px;font:600 10px/1 system-ui,sans-serif;color:#fff;background:#7c5cff;border-radius:8px;padding:3px 6px;white-space:nowrap;box-shadow:0 0 8px rgba(124,92,255,.6)}' +
      '.r{position:fixed;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;border:2px solid #7c5cff;pointer-events:none;animation:rip .5s ease-out forwards}' +
      '@keyframes rip{from{transform:scale(.4);opacity:.95}to{transform:scale(3.2);opacity:0}}' +
      '@keyframes glow{0%,100%{filter:drop-shadow(0 0 3px rgba(124,92,255,.9)) drop-shadow(0 0 9px rgba(124,92,255,.55))}50%{filter:drop-shadow(0 0 5px rgba(124,92,255,1)) drop-shadow(0 0 16px rgba(124,92,255,.8))}}' +
      '.c.pulse svg{animation:glow 1.4s ease-in-out infinite}' +
      '.calm *{animation:none!important}';

    function ensureCursor(o) {
      var C = S.cursor;
      if (C && C.host.isConnected) {
        C.el.className = 'c' + (o.reduce ? ' calm' : ' pulse');
        return C;
      }
      var host = document.createElement('x-' + rand());
      host.id = 'f' + rand();
      host.setAttribute('aria-hidden', 'true');
      host.setAttribute('inert', '');
      host.style.cssText =
        'all:initial;position:fixed;top:0;left:0;width:0;height:0;overflow:visible;' +
        'pointer-events:none;z-index:2147483647;contain:layout style;';
      var root = host.attachShadow({ mode: 'closed' });
      root.innerHTML =
        '<style>' + CURSOR_CSS + '</style>' +
        '<div class="c"><svg width="22" height="26" viewBox="0 0 22 26" aria-hidden="true">' +
        '<path d="M2 2 L2 20 L7 15.5 L10.5 23 L14 21.5 L10.6 14.2 L17.5 14 Z" fill="#fff" stroke="#7c5cff" stroke-width="2" stroke-linejoin="round"/>' +
        '</svg><span class="l">Flint</span></div>';
      (document.documentElement || document.body).appendChild(host);
      C = S.cursor = {
        host: host,
        root: root,
        el: root.querySelector('.c'),
        x: Math.round(window.innerWidth / 2),
        y: Math.round(window.innerHeight / 2),
        raf: 0,
        fade: 0,
        gone: 0,
        settle: 0,
      };
      C.el.className = 'c' + (o.reduce ? ' calm' : ' pulse');
      place(C, C.x, C.y);
      return C;
    }

    function place(C, x, y) {
      C.x = x;
      C.y = y;
      C.el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    }

    function reveal(C) {
      clearTimeout(C.fade);
      clearTimeout(C.gone);
      C.host.style.visibility = 'visible';
      C.el.style.opacity = '1';
    }

    /** Fade out a while after the last thing it did, then take it off the page. */
    function armFade(C) {
      clearTimeout(C.fade);
      clearTimeout(C.gone);
      C.fade = setTimeout(function () {
        C.el.style.opacity = '0';
        C.gone = setTimeout(function () {
          removeCursor();
        }, FADE_MS + 50);
      }, FADE_AFTER_MS);
    }

    function removeCursor() {
      var C = S.cursor;
      if (!C) return;
      clearTimeout(C.fade);
      clearTimeout(C.gone);
      clearTimeout(C.settle);
      if (C.raf && window.cancelAnimationFrame) window.cancelAnimationFrame(C.raf);
      if (C.host.parentNode) C.host.parentNode.removeChild(C.host);
      S.cursor = null;
    }

    function clampInt(n, lo, hi) {
      return Math.max(lo, Math.min(hi, n));
    }

    /** A slightly curved, eased path from where the pointer is to (tx, ty). */
    function glide(C, tx, ty, ms) {
      if (C.raf && window.cancelAnimationFrame) window.cancelAnimationFrame(C.raf);
      clearTimeout(C.settle);
      var x0 = C.x;
      var y0 = C.y;
      var dx = tx - x0;
      var dy = ty - y0;
      var dist = Math.sqrt(dx * dx + dy * dy) || 1;
      // Control point pushed sideways: the bend a hand makes.
      var bend = 0.16 * dist * (dx >= 0 ? 1 : -1);
      var cx = x0 + dx / 2 + (-dy / dist) * bend;
      var cy = y0 + dy / 2 + (dx / dist) * bend;
      var t0 = now();
      var step = function () {
        var t = clampInt((now() - t0) / ms, 0, 1);
        var e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        var a = (1 - e) * (1 - e);
        var b = 2 * (1 - e) * e;
        var c = e * e;
        place(C, a * x0 + b * cx + c * tx, a * y0 + b * cy + c * ty);
        if (t < 1 && window.requestAnimationFrame) C.raf = window.requestAnimationFrame(step);
      };
      if (window.requestAnimationFrame) C.raf = window.requestAnimationFrame(step);
      // A hidden or busy page throttles frames; the end point must still be reached.
      C.settle = setTimeout(function () {
        place(C, tx, ty);
      }, ms + 30);
    }

    function ripple(C, x, y) {
      var r = document.createElement('div');
      r.className = 'r';
      r.style.left = x + 'px';
      r.style.top = y + 'px';
      C.root.appendChild(r);
      setTimeout(function () {
        if (r.parentNode) r.parentNode.removeChild(r);
      }, 600);
    }

    function centerOf(el) {
      var rect = el.getBoundingClientRect();
      var vw = window.innerWidth || 1;
      var vh = window.innerHeight || 1;
      return {
        x: clampInt(rect.left + rect.width / 2, 6, Math.max(6, vw - 6)),
        y: clampInt(rect.top + rect.height / 2, 6, Math.max(6, vh - 6)),
        rect: rect,
        vw: vw,
        vh: vh,
      };
    }

    function fireMouse(el, type, x, y, buttons) {
      var Ctor = /^pointer/.test(type) && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      var init = {
        bubbles: !/enter$/.test(type),
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button: 0,
        buttons: buttons || 0,
      };
      if (Ctor !== MouseEvent) {
        init.pointerId = 1;
        init.pointerType = 'mouse';
        init.isPrimary = true;
      }
      var ev;
      try {
        ev = new Ctor(type, init);
      } catch (e) {
        // A `view` that is not a real Window (some embedded engines).
        delete init.view;
        ev = new Ctor(type, init);
      }
      el.dispatchEvent(ev);
    }

    /**
     * What a person's mouse does on arriving at `el`, and (for a click) pressing
     * it, so hover menus and framework handlers see a real sequence at real
     * coordinates. The pointer is snapped to the exact point first.
     */
    function pointerSequence(el, kind, o) {
      var c = centerOf(el);
      if (o.show) {
        var C = ensureCursor(o);
        reveal(C);
        place(C, c.x, c.y);
        if (kind === 'click' && !o.reduce) ripple(C, c.x, c.y);
        armFade(C);
      }
      if (kind !== 'click') return;
      var order = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'];
      for (var i = 0; i < order.length; i++) fireMouse(el, order[i], c.x, c.y, 0);
      fireMouse(el, 'pointerdown', c.x, c.y, 1);
      fireMouse(el, 'mousedown', c.x, c.y, 1);
      if (typeof el.focus === 'function') {
        try { el.focus({ preventScroll: true }); } catch (e) {}
      }
      fireMouse(el, 'pointerup', c.x, c.y, 0);
      fireMouse(el, 'mouseup', c.x, c.y, 0);
      el.click();
    }

    /** Start the pointer toward `id`; the host sleeps for the `wait` returned. */
    function movePointer() {
      var r = resolve(ARGS.id);
      if (r.err) return r.err;
      var o = pointerOpts();
      if (!o.show) return { ok: true, wait: 0 };
      var el = r.el;
      var c = centerOf(el);
      var off = c.rect.top < 0 || c.rect.bottom > c.vh || c.rect.left < 0 || c.rect.right > c.vw;
      var tx = c.x;
      var ty = c.y;
      var scrollMs = 0;
      if (off) {
        try {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: o.reduce ? 'auto' : 'smooth' });
        } catch (e) {}
        if (o.reduce) {
          var after = centerOf(el);
          tx = after.x;
          ty = after.y;
        } else {
          scrollMs = SCROLL_MS;
          ty = c.vh / 2;
        }
      }
      var C = ensureCursor(o);
      reveal(C);
      if (o.reduce) {
        place(C, tx, ty);
        armFade(C);
        return { ok: true, wait: 0 };
      }
      var dx = tx - C.x;
      var dy = ty - C.y;
      var ms = clampInt(GLIDE_MIN + Math.sqrt(dx * dx + dy * dy) * 0.35, GLIDE_MIN, GLIDE_MAX);
      if (scrollMs) setTimeout(function () { glide(C, tx, ty, ms); }, scrollMs);
      else glide(C, tx, ty, ms);
      armFade(C);
      return { ok: true, wait: scrollMs + ms };
    }

    function pointerControl() {
      var C = S.cursor;
      var mode = ARGS.mode;
      if (mode === 'remove') {
        removeCursor();
      } else if (C && mode === 'hide') {
        clearTimeout(C.fade);
        C.host.style.visibility = 'hidden';
      } else if (C && mode === 'show') {
        reveal(C);
        armFade(C);
      }
      return { ok: true, present: !!S.cursor };
    }

    // ---- scrolling ---------------------------------------------------------

    function isScrollable(el) {
      if (!el || el === document.body || el === document.documentElement) return false;
      var cs;
      try { cs = getComputedStyle(el); } catch (e) { return false; }
      var ov = (cs.overflowY || '') + ' ' + (cs.overflowX || '');
      return /(auto|scroll)/.test(ov) && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    }

    /** The thing a scroll acts on: the node id's own box if it scrolls, else the page. */
    function scrollTarget(r) {
      return r && r.el && ARGS.direction && isScrollable(r.el) ? r.el : null;
    }

    function metrics(box) {
      if (box) {
        return {
          x: box.scrollLeft, y: box.scrollTop,
          maxX: Math.max(0, box.scrollWidth - box.clientWidth),
          maxY: Math.max(0, box.scrollHeight - box.clientHeight),
          w: box.clientWidth, h: box.clientHeight,
        };
      }
      var se = document.scrollingElement || document.documentElement;
      var vw = window.innerWidth || se.clientWidth || 0;
      var vh = window.innerHeight || se.clientHeight || 0;
      return {
        x: window.scrollX || 0, y: window.scrollY || 0,
        maxX: Math.max(0, (se.scrollWidth || 0) - vw),
        maxY: Math.max(0, (se.scrollHeight || 0) - vh),
        w: vw, h: vh,
      };
    }

    function scrollOp() {
      var r = null;
      if (ARGS.id != null && ARGS.id !== '') {
        r = resolve(ARGS.id);
        if (r.err) return r.err;
      }
      var o = pointerOpts();
      var box = scrollTarget(r);
      var m = metrics(box);
      var behavior = o.reduce ? 'auto' : 'smooth';
      if (r && !box) {
        // A node id with no direction: bring it into view.
        if (ARGS.dry) return { ok: true, dry: true };
        var already = centerOf(r.el);
        var inView = already.rect.top >= 0 && already.rect.bottom <= already.vh && already.rect.left >= 0 && already.rect.right <= already.vw;
        if (!inView) {
          try { r.el.scrollIntoView({ block: 'center', inline: 'center', behavior: behavior }); } catch (e) {}
        }
        var ms0 = inView || o.reduce ? 0 : SCROLL_MS + 150;
        if (o.show) {
          var C0 = ensureCursor(o);
          reveal(C0);
          armFade(C0);
        }
        return { ok: true, wait: ms0 };
      }
      var dir = ARGS.direction;
      var amount = ARGS.amount || { kind: 'page' };
      var dim = dir === 'up' || dir === 'down' ? m.h : m.w;
      var px = amount.kind === 'half' ? dim * 0.5 : amount.kind === 'px' ? amount.px : dim * 0.9;
      px = Math.max(1, Math.round(px));
      var dx = dir === 'left' ? -px : dir === 'right' ? px : 0;
      var dy = dir === 'up' ? -px : dir === 'down' ? px : 0;
      if (ARGS.dry) return { ok: true, dry: true };

      // The pointer hovers where a wheel would act: the box, or the viewport centre.
      var px0 = box ? centerOf(box) : null;
      var hx = px0 ? px0.x : Math.round((window.innerWidth || 0) / 2);
      var hy = px0 ? px0.y : Math.round((window.innerHeight || 0) / 2);
      var glideMs = 0;
      if (o.show) {
        var C = ensureCursor(o);
        reveal(C);
        if (o.reduce) {
          place(C, hx, hy);
        } else {
          var gx = hx - C.x;
          var gy = hy - C.y;
          glideMs = clampInt(GLIDE_MIN * 0.6 + Math.sqrt(gx * gx + gy * gy) * 0.2, 80, SCROLL_MS);
          glide(C, hx, hy, glideMs);
        }
        armFade(C);
      }
      var at = (document.elementFromPoint && document.elementFromPoint(hx, hy)) || document.body;
      var wheel = new WheelEvent('wheel', {
        bubbles: true, cancelable: true, composed: true,
        clientX: hx, clientY: hy, deltaX: dx, deltaY: dy, deltaMode: 0,
      });
      var handled = !at.dispatchEvent(wheel);
      if (!handled) {
        var opts = { left: dx, top: dy, behavior: behavior };
        if (box) box.scrollBy(opts);
        else window.scrollBy(opts);
      }
      var travel = o.reduce || handled ? 0 : clampInt(150 + Math.sqrt(dx * dx + dy * dy) * 0.25, 200, 650);
      return { ok: true, wait: Math.min(900, glideMs + travel), handled: handled };
    }

    function scrollInfo() {
      var r = null;
      if (ARGS.id != null && ARGS.id !== '') {
        r = resolve(ARGS.id);
        if (r.err) return r.err;
      }
      var box = scrollTarget(r);
      var m = metrics(box);
      var out = {
        ok: true,
        url: location.href,
        x: Math.round(m.x), y: Math.round(m.y),
        max_x: Math.round(m.maxX), max_y: Math.round(m.maxY),
        more: {
          up: m.y > 1, down: m.y < m.maxY - 1,
          left: m.x > 1, right: m.x < m.maxX - 1,
        },
        scrolled: box ? 'element' : 'page',
      };
      if (r && !box) {
        var c = centerOf(r.el);
        out.target_visible = c.rect.top >= 0 && c.rect.bottom <= c.vh && c.rect.left >= 0 && c.rect.right <= c.vw;
      }
      return out;
    }

    // ---- ops -------------------------------------------------------------

    function resolve(id) {
      var m = /^(\d+)\.(\d+)$/.exec(String(id));
      if (!m) return { err: fail('bad_id', 'Not a node id: ' + clip(id, 40) + '. Use an id from browser_snapshot, like 3.12.') };
      if (+m[1] !== S.gen) {
        return { err: fail('stale', 'Node ' + id + ' is from an older snapshot. The page may have changed: call browser_snapshot again.') };
      }
      var el = S.map.get(String(id));
      if (!el) return { err: fail('stale', 'Node ' + id + ' is not in the current snapshot. Call browser_snapshot again.') };
      if (!el.isConnected) {
        return { err: fail('stale', 'Node ' + id + ' is no longer on the page. Call browser_snapshot again.') };
      }
      return { el: el };
    }

    function snapshot() {
      S.gen += 1;
      S.map = new Map();
      var lines = [];
      var chars = 0;
      var nodes = 0;
      var truncated = false;

      function push(depth, text) {
        if (lines.length >= MAX_LINES || chars > MAX_CHARS) {
          truncated = true;
          return false;
        }
        var line = new Array(Math.min(depth, 8) + 1).join('  ') + '- ' + text;
        chars += line.length + 1;
        lines.push(line);
        return true;
      }

      function describe(el, role) {
        var parts = [];
        var name = labelOf(el);
        var tag = el.tagName;
        parts.push(role || tag.toLowerCase());
        if (name) parts.push('"' + name.replace(/"/g, "'") + '"');
        if (tag === 'A') {
          var href = el.getAttribute('href') || '';
          try {
            href = new URL(href, document.baseURI).href;
          } catch (e) {}
          parts.push('href=' + clip(href, 200));
        }
        if (tag === 'INPUT') {
          var type = (el.type || 'text').toLowerCase();
          if (type !== 'text') parts.push('type=' + type);
          if (type === 'checkbox' || type === 'radio') {
            parts.push(el.checked ? 'checked' : 'unchecked');
          } else if (type !== 'submit' && type !== 'button' && type !== 'reset' && type !== 'image') {
            if (sensitiveField(el)) {
              if (el.value) parts.push('value=••• (hidden)');
              parts.push('(sensitive field: the agent cannot type here)');
            } else if (el.value) {
              parts.push('value="' + clip(el.value, 80).replace(/"/g, "'") + '"');
            }
          }
        }
        if (tag === 'TEXTAREA') {
          if (sensitiveField(el)) parts.push('(sensitive field: the agent cannot type here)');
          else if (el.value) parts.push('value="' + clip(el.value, 80).replace(/"/g, "'") + '"');
        }
        if (tag === 'SELECT') {
          var opts = [];
          for (var i = 0; i < el.options.length && i < 20; i++) {
            opts.push(clip(el.options[i].label || el.options[i].value, 40));
          }
          parts.push('options=[' + opts.join(' | ') + (el.options.length > 20 ? ' | ...' : '') + ']');
          if (el.selectedIndex >= 0 && el.options[el.selectedIndex]) {
            parts.push('selected="' + clip(el.options[el.selectedIndex].label, 40) + '"');
          }
        }
        if (el.disabled) parts.push('disabled');
        if (el.required) parts.push('required');
        return parts.join(' ');
      }

      var suppress = 0;

      function walk(node, depth) {
        if (truncated) return;
        if (node.nodeType !== 1) return;
        var tag = node.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'HEAD' || tag === 'SVG' || tag === 'svg') return;
        if (!visible(node)) return;

        var role = roleOf(node);
        var childDepth = depth;
        var heading = false;

        if (/^H[1-6]$/.test(tag) || role === 'heading') {
          var ht = clip(node.textContent, 160);
          heading = true;
          if (ht) push(depth, 'heading level ' + (tag.charAt(1) || '2') + ' "' + ht.replace(/"/g, "'") + '"');
          // Links inside headings are still reachable.
        } else if (role && (INTERACTIVE_ROLES[role] || role === 'textbox')) {
          if (nodes < MAX_NODES) {
            nodes += 1;
            var id = S.gen + '.' + nodes;
            S.map.set(id, node);
            push(depth, '[' + id + '] ' + describe(node, role));
          } else {
            truncated = true;
            return;
          }
          // A control's text is its name; do not repeat it as children.
          return;
        } else if (STRUCTURE[tag]) {
          var sr = STRUCTURE[tag];
          if (sr) {
            var nm = node.getAttribute('aria-label');
            push(depth, sr + (nm ? ' "' + clip(nm, 60).replace(/"/g, "'") + '"' : ''));
            childDepth = depth + 1;
          }
        } else if (tag === 'IMG') {
          var alt = node.getAttribute('alt');
          if (alt) push(depth, 'img "' + clip(alt, 80).replace(/"/g, "'") + '"');
          return;
        } else if (tag === 'IFRAME' || tag === 'FRAME') {
          var doc = null;
          try {
            doc = node.contentDocument;
          } catch (e) {}
          if (doc && doc.body) {
            push(depth, 'frame ' + (node.title ? '"' + clip(node.title, 60) + '"' : ''));
            walk(doc.body, depth + 1);
          } else {
            push(depth, 'frame (cross-origin, not readable)');
          }
          return;
        } else {
          var t = suppress || tag === 'LABEL' ? '' : ownText(node);
          // A separator ("| |", "-", a bullet) is not content.
          if (t && /[^\s|\u2022\u00B7\-\u2013\u2014_*#<>\/\\.,;:!?()\[\]{}~=+]/.test(t)) push(depth, 'text "' + t.replace(/"/g, "'") + '"');
        }

        if (node.shadowRoot) {
          for (var s = node.shadowRoot.firstElementChild; s; s = s.nextElementSibling) walk(s, childDepth);
        }
        if (heading) suppress += 1;
        for (var c = node.firstElementChild; c; c = c.nextElementSibling) walk(c, childDepth);
        if (heading) suppress -= 1;
      }

      if (document.body) walk(document.body, 0);
      return {
        ok: true,
        url: location.href,
        title: document.title,
        nodes: nodes,
        generation: S.gen,
        truncated: truncated,
        snapshot: lines.join('\n'),
      };
    }

    var SUBMIT_WORDS = /\b(buy|purchase|pay|checkout|place order|order now|subscribe|donate|delete|remove|confirm|submit|send|post|publish|sign ?up|register|log ?in|sign ?in|transfer|withdraw|unsubscribe|cancel|apply|book|reserve|upgrade|authorize|allow|accept|agree|continue to payment)\b/i;

    function submitReason(el) {
      var tag = el.tagName;
      // The attribute, not the property: a <button> with no type reads back as
      // "submit" whether or not it is in a form.
      var type = (el.getAttribute('type') || '').toLowerCase();
      var inForm = !!(el.form || (el.closest && el.closest('form')));
      if ((tag === 'BUTTON' && inForm && (type === '' || type === 'submit')) ||
          (tag === 'INPUT' && (type === 'submit' || type === 'image') && inForm)) {
        return 'it submits a form';
      }
      var label = labelOf(el);
      if (label && SUBMIT_WORDS.test(label)) return 'its label reads "' + clip(label, 40) + '"';
      return '';
    }

    function click() {
      var r = resolve(ARGS.id);
      if (r.err) return r.err;
      var el = r.el;
      if (el.disabled) return fail('disabled', 'That control is disabled.');
      if (!visible(el)) return fail('hidden', 'That control is not visible. Call browser_snapshot again.');
      if (el.tagName === 'A') {
        var href = (el.getAttribute('href') || '').trim().toLowerCase();
        if (href.indexOf('javascript:') === 0) return fail('blocked', 'Links that run script are not clicked.');
      }
      var reason = submitReason(el);
      if (reason && !ARGS.confirmed) {
        return { ok: true, needs_confirm: true, label: labelOf(el), reason: reason };
      }
      if (ARGS.dry) return { ok: true, dry: true, label: ARGS.id != null && ARGS.id !== '' ? labelOf(el) : '' };
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      var before = location.href;
      pointerSequence(el, 'click', pointerOpts());
      return { ok: true, clicked: labelOf(el), url: location.href, url_before: before };
    }

    function typeText() {
      var r = resolve(ARGS.id);
      if (r.err) return r.err;
      var el = r.el;
      var text = String(ARGS.text == null ? '' : ARGS.text);
      if (sensitiveField(el)) {
        return fail('sensitive_field', 'The agent does not type into password, payment-card or one-time-code fields. Ask the user to fill it in.');
      }
      var tag = el.tagName;
      if (tag === 'INPUT') {
        var type = (el.type || 'text').toLowerCase();
        if (['text', 'search', 'email', 'url', 'tel', 'number', 'date', 'time', 'datetime-local', 'month', 'week'].indexOf(type) === -1) {
          return fail('unsupported', 'Cannot type into an input of type ' + type + '. Use browser_click or browser_select.');
        }
      } else if (tag !== 'TEXTAREA' && !(el.isContentEditable)) {
        return fail('unsupported', 'That element is not a text field.');
      }
      if (el.disabled || el.readOnly) return fail('disabled', 'That field is read-only or disabled.');
      if (ARGS.dry) return { ok: true, dry: true, label: ARGS.id != null && ARGS.id !== '' ? labelOf(el) : '' };
      try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
      pointerSequence(el, 'rest', pointerOpts());
      el.focus();
      var append = ARGS.clear === false;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        var proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, append ? el.value + text : text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        if (!append) document.execCommand('selectAll', false, null);
        if (!document.execCommand('insertText', false, text)) {
          el.textContent = append ? el.textContent + text : text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      return { ok: true, typed: text.length, field: labelOf(el), url: location.href };
    }

    var KEYS = {
      Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
      ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Backspace: 'Backspace', Delete: 'Delete',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Space: ' ',
    };

    function press() {
      var key = KEYS[ARGS.key];
      if (!key) return fail('bad_key', 'Unsupported key. Use one of: ' + Object.keys(KEYS).join(', ') + '.');
      var el;
      if (ARGS.id != null && ARGS.id !== '') {
        var r = resolve(ARGS.id);
        if (r.err) return r.err;
        el = r.el;
      } else {
        el = document.activeElement || document.body;
      }
      if (sensitiveField(el) && key !== 'Tab' && key !== 'Escape') {
        return fail('sensitive_field', 'The agent does not interact with password or payment-card fields.');
      }
      var form = el.form || (el.closest && el.closest('form'));
      var submits = key === 'Enter' && form && el.tagName !== 'TEXTAREA' && el.tagName !== 'A';
      if (submits && !ARGS.confirmed) {
        return { ok: true, needs_confirm: true, label: labelOf(el), reason: 'pressing Enter here submits a form' };
      }
      if (ARGS.dry) return { ok: true, dry: true, label: ARGS.id != null && ARGS.id !== '' ? labelOf(el) : '' };
      if (ARGS.id != null && ARGS.id !== '') pointerSequence(el, 'rest', pointerOpts());
      if (typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch (e) {} }
      var init = { key: key, code: ARGS.key === 'Space' ? 'Space' : key, bubbles: true, cancelable: true };
      var down = new KeyboardEvent('keydown', init);
      var proceed = el.dispatchEvent(down);
      el.dispatchEvent(new KeyboardEvent('keypress', init));
      if (proceed && key === 'Enter') {
        if (submits) {
          if (form.requestSubmit) form.requestSubmit();
          else form.submit();
        } else if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') {
          el.click();
        }
      }
      el.dispatchEvent(new KeyboardEvent('keyup', init));
      return { ok: true, pressed: ARGS.key, url: location.href };
    }

    function selectOption() {
      var r = resolve(ARGS.id);
      if (r.err) return r.err;
      var el = r.el;
      if (el.tagName !== 'SELECT') return fail('unsupported', 'That element is not a <select>. Use browser_click for custom dropdowns.');
      if (el.disabled) return fail('disabled', 'That control is disabled.');
      var want = String(ARGS.value == null ? '' : ARGS.value);
      var idx = -1;
      var i;
      for (i = 0; i < el.options.length; i++) {
        if (el.options[i].value === want || el.options[i].label === want) { idx = i; break; }
      }
      if (idx < 0) {
        var low = want.toLowerCase();
        for (i = 0; i < el.options.length; i++) {
          if ((el.options[i].label || '').toLowerCase() === low || (el.options[i].value || '').toLowerCase() === low) { idx = i; break; }
        }
      }
      if (idx < 0) {
        var have = [];
        for (i = 0; i < el.options.length && i < 30; i++) have.push(clip(el.options[i].label || el.options[i].value, 40));
        return fail('no_option', 'No option matches. Options: ' + have.join(' | '));
      }
      if (ARGS.dry) return { ok: true, dry: true, label: ARGS.id != null && ARGS.id !== '' ? labelOf(el) : '' };
      pointerSequence(el, 'rest', pointerOpts());
      el.selectedIndex = idx;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selected: clip(el.options[idx].label, 60), url: location.href };
    }

    function readText() {
      var root = document.body;
      if (ARGS.id != null && ARGS.id !== '') {
        var r = resolve(ARGS.id);
        if (r.err) return r.err;
        root = r.el;
      }
      var text = root ? root.innerText || root.textContent || '' : '';
      var max = ARGS.max || 40000;
      return {
        ok: true,
        url: location.href,
        title: document.title,
        length: text.length,
        text: text.length > max ? text.slice(0, max) : text,
      };
    }

    switch (OP) {
      case 'info':
        return { ok: true, url: location.href, title: document.title, ready: document.readyState };
      case 'text':
        return readText();
      case 'snapshot':
        return snapshot();
      case 'click':
        return click();
      case 'type':
        return typeText();
      case 'press':
        return press();
      case 'select':
        return selectOption();
      case 'move':
        return movePointer();
      case 'scroll':
        return scrollOp();
      case 'scrollinfo':
        return scrollInfo();
      case 'pointer':
        return pointerControl();
      default:
        return fail('bad_op', 'Unknown operation ' + OP);
    }
  } catch (e) {
    return fail('script', String((e && e.message) || e));
  }
})
