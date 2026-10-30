// TwinDesk Windows — Simplified Chinese UI.
//
// Loaded after ui-kit.js (which sets window.UI) and before the tab scripts (which call UI.*),
// so every string that reaches the DOM through a UI helper is looked up in window.__ZH first.
// A string with no entry is left in English: the dictionary can grow one line at a time.
// Outside a Chinese system locale this file does nothing.
//
// Three layers:
//   1. helper wrappers - translate the label/title/hint arguments before UI.fill() expands the
//      {me} / {name} tokens, so dictionary values keep the same tokens as their keys.
//   2. node pass - whole-text-node match over each rendered page (UI.fillTree) and over anything
//      written outside a page root: the sidebar badges, the connection line, app.html's markup.
//   3. pattern channel - a few runtime-composed sentences ('Turned off on ' + name) need the
//      device name moved, which no exact match can express; those are the RX table below.
'use strict';

(function () {
  const UI = window.UI;
  const DICT = window.__ZH;
  if (!UI || !DICT) return;

  // Simplified Chinese only: another locale keeps the app exactly as it ships.
  const lang = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  if (!/^zh/i.test(lang)) return;
  document.documentElement.lang = 'zh-CN';

  // Ordered most specific first: the first match wins. A tail that swallows a device, app or
  // window name is capped at three words, because a longer run of words is an untranslated
  // sentence and `在 the other computer now 上打开 the folder` is worse than leaving it English.
  // Patterns anchored by a literal tail (… and back, … Open to watch.) can use ANY safely.
  const ANY = '(.+?)';
  const NAME = '([^\\s]+(?:\\s+[^\\s]+){0,2})';
  const RX = [
    ['^TwinDesk on ' + ANY + ' asks to pair with this PC\\. Press Pair there, then compare the codes\\.$',
      '$1 上的 TwinDesk 请求与本机配对。请在该设备上点“配对”，然后核对验证码。'],
    ['^Turn on Pictures on ' + ANY + ' too \\(TwinDesk 2\\.3 or later there\\)$',
      '请在 $1 上也开启“图片”（对方需要 TwinDesk 2.3 或更新版本）'],
    ['^Waiting for Allow on ' + ANY + '…$', '正在等待 $1 点“允许”…'],
    ['^Sharing on ' + ANY + '\\. Open to watch\\.$', '$1 正在共享，点“打开”即可观看。'],
    ['^Double-tap to type on ' + ANY + ' and back$', '双击即可在 $1 上输入，再双击返回'],
    ['^Receive input from ' + NAME + '$', '接收来自 $1 的输入'],
    ['^Turned on on ' + NAME + '$', '$1 上已开启'],
    ['^Turned off on ' + NAME + '$', '$1 上已关闭'],
    ['^Turn on sharing on ' + NAME + '$', '在 $1 上开启共享'],
    ['^Open starts sharing on ' + NAME + '$', '点“打开”会在 $1 上开始共享'],
    ['^Set in TwinDesk on ' + NAME + '$', '请在 $1 的 TwinDesk 中设置'],
    ['^Playing on ' + NAME + '$', '正在 $1 上播放'],
    ['^Hotkey on ' + NAME + '$', '$1 上的快捷键'],
    ['^Shortcuts on ' + NAME + '$', '$1 上的快捷键组合'],
    ['^Press Pair on ' + NAME + '$', '在 $1 上点“配对”'],
    ['^Waiting for ' + NAME + '$', '正在等待 $1'],
    ['^Open on ' + NAME + '$', '在 $1 上打开'],
    ['^Open ' + NAME + ' on ' + NAME + '$', '在 $2 上打开 $1'],
    // Page headings name the peer: app.js writes `p.Name + ' on ' + p.me` straight to textContent,
    // outside any template. The fallback device names are translated by the UI.peer wrapper below;
    // the English spellings stay here for text written before that wrapper ran.
    ['^另一台电脑 on ' + ANY + '$', '$1 上的另一台电脑'],
    ['^' + NAME + ' on 另一台电脑$', '另一台电脑上的 $1'],
    ['^这台电脑 on ' + ANY + '$', '$1 上的这台电脑'],
    ['^' + NAME + ' on 这台电脑$', '这台电脑上的 $1'],
    ['^The other computer on ' + ANY + '$', '$1 上的另一台电脑'],
    ['^' + NAME + ' on the other computer$', '另一台电脑上的 $1'],
    ['^' + NAME + ' on This PC$', '这台电脑上的 $1'],
    // The "Keyboard and mouse" pill: 'On ' + name, or 'Name is using Name'.
    ['^' + NAME + ' is using ' + NAME + '$', '$1 正在使用 $2'],
    ['^On ([^.!?]{1,40})$', '在 $1 上'],
    // Cursor lock: a base sentence plus an optional sentence about the lock key.
    ['^While the pointer is on ' + ANY + ', ' + ANY + ' on either keyboard locks or unlocks it \\(each computer has its own key\\)\\.$',
      '指针位于 $1 时，在任一键盘上按 $2 即可锁定或解锁（每台电脑的按键各自独立）。'],
    ['^Keeps the pointer on ' + ANY + ', where it is now, even when the mouse is plugged into another computer\\.$',
      '让指针保持在 $1（当前位置），即使鼠标接在另一台电脑上。'],
    ['^The pointer stays on ' + ANY + ': the screen edges don’t cross\\.$', '指针停留在 $1：屏幕边缘不会穿越。'],
    // Virtual camera: the hint names the camera other apps will see.
    ['^Off: the picture stays in TwinDesk\\.$', '关闭：画面只留在 TwinDesk 中。'],
    ['^On: it’s also (.+), a camera other apps can pick$', '开启：它还会作为$1供其他应用选择。'],
    // Files: 'Select files, press C, then V on the other computer'.
    ['^Select files, press (.+?), then (.+?) on (.+)$', '选择文件，按 $1，然后在 $3 上按 $2'],
    // General: 'Right-click files › Send to › Name (TwinDesk)'.
    ['^Right-click files › Send to › (.+?) \\(TwinDesk\\)$', '右键文件 › 发送至 › $1 (TwinDesk)'],
    // The received-files row joins the folder path and the sentence with ' · '.
    ['^(.+?) · Files sent to (.+?) from another computer or a phone, and what’s saved from a phone’s Files and Photos$',
      '$1 · 从其他电脑或手机发送到 $2 的文件，以及从手机“文件”和“照片”中保存的内容'],
    // About: 'Version 2.5.0-beta.1 · checked 21:20'.
    ['^Version (.+?) · checked (.+)$', '版本 $1 · 检查于 $2'],
    ['^Version (.+)$', '版本 $1'],
    ['^checked (.+)$', '检查于 $1'],
    ['^No releases published yet$', '尚未发布任何版本'],
    ['^TwinDesk on ' + NAME + '$', '$1 上的 TwinDesk'],
    ['^Showing ' + ANY + '$', '正在显示 $1'],
    ['^Playing ' + NAME + '$', '正在播放 $1'],
    ['^Open ' + NAME + '$', '打开 $1'],
    ['^Drive ' + NAME + '$', '驱动器 $1'],
    ['^Phase (\\d+)$', '阶段 $1'],
    ['^Coming in phase (\\d+)$', '将于阶段 $1 推出'],
    ['^(\\d+) s ago$', '$1 秒前'],
    ['^(\\d+) min ago$', '$1 分钟前'],
    ['^(\\d+) h ago$', '$1 小时前'],
    ['^Hardware( .*)?$', '硬件$1'],
    ['^Software( .*)?$', '软件$1'],
  ].map(([p, r]) => [new RegExp(p), r]);

  // Whitespace-normalised index, so a source string wrapped over several lines still matches.
  // The exact key always wins in t(); this only catches layout whitespace.
  const norm = new Map();
  const flatten = (s) => s.replace(/\s+/g, ' ').trim();
  for (const key in DICT) {
    const k = flatten(key);
    if (!norm.has(k)) norm.set(k, DICT[key]);
  }

  // Returns the translation of the *trimmed* string, or null. Exact dictionary entries are
  // checked before patterns: a key is a decision, a pattern is a guess.
  function match(s) {
    if (DICT[s] !== undefined) return DICT[s];
    const flat = flatten(s);
    const hit = norm.get(flat);
    if (hit !== undefined) return hit;
    for (const [re, r] of RX) if (re.test(flat)) return flat.replace(re, r);
    return null;
  }

  // Runtime code joins a prefix or two sentences with ' · ' or '. ' ("Version 1.2 · checked 3:04",
  // "…into another. While the pointer is on X, …"). Neither half is a dictionary key on its own
  // line, so translate the pieces and keep the separator; Chinese drops the space after a stop.
  const SEPS = [' · ', '. '];
  function compose(flat, depth) {
    if (depth > 2) return null;
    for (const sep of SEPS) {
      for (let i = flat.indexOf(sep); i > 0; i = flat.indexOf(sep, i + 1)) {
        // a stop belongs to the sentence before it, so it stays on the left half
        const cut = sep === '. ' ? i + 1 : i;
        const left = flat.slice(0, cut);
        const right = flat.slice(i + sep.length);
        if (!right) break;
        const l = match(left) ?? compose(left, depth + 1);
        if (l == null) continue;
        const r = match(right) ?? compose(right, depth + 1);
        if (r == null) continue;
        return l + (sep === '. ' ? '' : sep) + r;
      }
    }
    return null;
  }

  function lookup(s) {
    const hit = match(s);
    return hit !== null ? hit : compose(flatten(s), 0);
  }

  // A half-width space between two Chinese characters is a typesetting error; it shows up once a
  // Chinese device name ("另一台电脑") is substituted into a template built around a Latin name.
  const CJK = '\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef';
  const CJKSPACE = new RegExp(`(?<=[${CJK}]) (?=[${CJK}])`, 'g');
  const CJK_GAP = new RegExp(`(?<=[${CJK}]) (?=[${CJK}])`);
  const collapse = (s) => s.replace(CJKSPACE, '');

  // A pattern can capture a name before the UI.peer wrapper has replaced it (the heading is written
  // straight to textContent). A real device is called neither of these, so this only fixes fallbacks.
  const finish = (s) => collapse(s
    .replace(/\bthe other computer\b/g, '另一台电脑')
    .replace(/\bThe other computer\b/g, '另一台电脑')
    .replace(/\bThis PC\b/g, '这台电脑'));

  function t(s) {
    if (typeof s !== 'string' || s === '') return s;
    const out = lookup(s);
    if (out === null || out === s) return CJK_GAP.test(s) ? collapse(s) : s;
    return finish(pad(s, out));
  }

  // Keep the line breaks and indentation the source put around the text.
  function pad(original, translated) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(original);
    return m[1] + translated.trim() + m[3];
  }

  function tProps(props) {
    if (!props || typeof props !== 'object') return props;
    for (const a of ['text', 'title', 'placeholder']) if (typeof props[a] === 'string') props[a] = t(props[a]);
    const attrs = props.attrs;
    if (attrs && typeof attrs === 'object') {
      for (const a of ['aria-label', 'title', 'placeholder', 'alt']) if (typeof attrs[a] === 'string') attrs[a] = t(attrs[a]);
    }
    return props;
  }

  // Wrap a UI helper, keeping `this` and the original signature.
  function wrap(name, build) {
    const orig = UI[name];
    if (typeof orig !== 'function') return;
    UI[name] = build(orig);
  }

  wrap('el', (orig) => function (tag, props, children) {
    return orig.call(UI, tag, tProps(props), children);
  });

  wrap('tab', (orig) => function (def) {
    if (def && typeof def === 'object') {
      for (const k of ['title', 'desc', 'heading', 'tag']) if (typeof def[k] === 'string') def[k] = t(def[k]);
    }
    return orig.call(UI, def);
  });

  wrap('button', (orig) => function (label, onClick, cls) {
    return orig.call(UI, t(label), onClick, cls);
  });

  wrap('switch', (orig) => function (onChange, opts) {
    if (opts && typeof opts === 'object' && typeof opts.label === 'string') opts.label = t(opts.label);
    return orig.call(UI, onChange, opts);
  });

  wrap('row', (orig) => function (label, hint, controls, extra) {
    const row = orig.call(UI, t(label), t(hint), controls, extra);
    if (row && typeof row.setHint === 'function') {
      const set = row.setHint;
      row.setHint = (x) => set(t(x));
    }
    return row;
  });

  wrap('card', (orig) => function (title, rows, opts) {
    return orig.call(UI, t(title), rows, opts);
  });

  wrap('note', (orig) => function (kind, text) {
    const n = orig.call(UI, kind, t(text));
    if (n && typeof n.set === 'function') {
      const set = n.set;
      n.set = (x) => set(t(x));
    }
    return n;
  });

  // UI.peer() hands templates the name to substitute: "the other computer" before anything is
  // paired, "This PC" when this machine has no name yet. Those are synthetic, never a real device
  // name, so translating them only changes what the user reads — never what is sent to a peer.
  wrap('peer', (orig) => function (s) {
    const p = orig.call(UI, s);
    if (!p) return p;
    let changed = false;
    if (p.name === 'the other computer') {
      p.name = p.Name = p.the = p.them = p.there = p.There = '另一台电脑';
      changed = true;
    }
    if (p.me === 'This PC') { p.me = p.us = '这台电脑'; changed = true; }
    if (changed) { p.toMe = p.name + ' → ' + p.me; p.fromMe = p.me + ' → ' + p.name; }
    return p;
  });

  // Direct UI.fill() calls (26 in the tab scripts) get the template before the device names go in.
  wrap('fill', (orig) => function (s) {
    return finish(orig.call(UI, t(s)));
  });

  // ---- layer 2: the node pass ----

  // Chat bubbles hold what the phone sent, and code/monospace elements hold commands and
  // keystrokes. Both must reach the screen exactly as they arrived.
  const RAW = '.hub-bubble, code, kbd, pre, .mono';

  function fixText(n) {
    const v = n.nodeValue;
    if (!v) return;
    const parent = n.parentElement;
    if (parent && parent.closest && parent.closest(RAW)) return;
    if (!/[A-Za-z]{3}/.test(v)) {
      // app.js fills {name} straight into textContent (renderPeer), so a translated sentence can
      // end up with a Chinese name and English spacing: "与 另一台电脑 共享文件夹".
      if (CJK_GAP.test(v)) n.nodeValue = collapse(v);
      return;
    }
    const out = t(v);
    if (out !== v) n.nodeValue = out;
  }

  function fixAttrs(el) {
    for (const a of ['title', 'aria-label', 'placeholder']) {
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      const v = el.getAttribute(a);
      if (v) { const out = t(v); if (out !== v) el.setAttribute(a, out); }
    }
  }

  // Writing an already-translated value back would queue another record, so t() only differs
  // from its input once; the observer settles instead of looping.
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { fixText(root); return; }
    if (root.nodeType !== 1) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) fixText(n);
    if (root.hasAttribute && (root.hasAttribute('title') || root.hasAttribute('aria-label') || root.hasAttribute('placeholder'))) fixAttrs(root);
    for (const el of root.querySelectorAll('[title], [aria-label], [placeholder]')) fixAttrs(el);
  }

  wrap('fillTree', (orig) => function (root) {
    orig.call(UI, root);
    walk(root);
  });

  // The sidebar badges, the connection line and app.html's own markup are written outside any
  // page root, so fillTree never sees them.
  const seen = new WeakSet();
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') { fixText(r.target); continue; }
      if (r.type === 'attributes') { fixAttrs(r.target); continue; }
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && seen.has(n)) continue;
        if (n.nodeType === 1) seen.add(n);
        walk(n);
      }
    }
  }).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['title', 'aria-label', 'placeholder'],
  });

  document.addEventListener('DOMContentLoaded', () => walk(document.body));
  if (document.body) walk(document.body);
})();
