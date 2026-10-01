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
          if (t) push(depth, 'text "' + t.replace(/"/g, "'") + '"');
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
      if (ARGS.dry) return { ok: true, dry: true };
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      var before = location.href;
      if (typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch (e) {} }
      el.click();
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
      if (ARGS.dry) return { ok: true, dry: true };
      try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
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
      if (ARGS.dry) return { ok: true, dry: true };
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
      if (ARGS.dry) return { ok: true, dry: true };
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
      default:
        return fail('bad_op', 'Unknown operation ' + OP);
    }
  } catch (e) {
    return fail('script', String((e && e.message) || e));
  }
})
