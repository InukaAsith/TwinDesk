// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// An introduction to a feature, on its page in place of the settings: a picture of its own, animated, in
// the colours of its sidebar icon, its name, what it does, and Dismiss, which shows the settings. On a page
// with a switch at the top it's there while that's off, and Dismiss holds until TwinDesk starts again; on
// one without (Files, Terminal, Mount) it's there until dismissed, which is remembered. Every desktop app;
// shared/mesh-intro.js draws devices with device().
//   FeatureArt.FREE                -> tab ids that work without a connected device; on the others (and Overview's
//                                     feature cards) switches do nothing while body.no-peer (nothing connected)
//   FeatureArt.has(id)             -> an introduction for that tab
//   FeatureArt.device(kind, x, y)  -> 'monitor' | 'laptop' | 'phone' as an outline (shared/mesh-intro.js)
//   FeatureArt.dismissed(id)
//   FeatureArt.create(id, { color, keep, onDismiss }) -> { el, set(show) }; color: the tab's (a CSS gradient),
//     keep: Dismiss is remembered
(function () {
  const t = (text) => window.I18n ? window.I18n.t(text) : text;
  const FREE = ['overview', 'multi', 'general', 'about', 'phone', 'calls', 'messages', 'media', 'pfiles', 'web', 'airplay', 'wd-overview', 'wd-share', 'wd-receive', 'wd-remote', 'wd-clipboard', 'wd-notifications', 'wd-files', 'wd-drop', 'wd-audio', 'wd-camera']; // web, airplay, wd-*: TwinDesk Web (shared/ui-web.js), its own server

  // Nothing connected: a switch of a feature can't be turned on or off (it shows dimmed, styled from
  // .no-peer). Held here, before the page's own handler, so each page keeps setting its switches as it does.
  const HELD = '.page:not(.free) .switch, .page.free .dir-card .switch';
  document.addEventListener('click', (e) => {
    if (document.body.classList.contains('no-peer') && e.target.matches && e.target.matches(HELD)) e.preventDefault();
  }, true);

  function device(k, x, y) {
    if (k === 'phone') {
      return `<rect class="mi-body" x="${x - 16}" y="${y - 30}" width="32" height="60" rx="7"/>`
        + `<rect class="mi-screen" x="${x - 11}" y="${y - 23}" width="22" height="42" rx="3"/>`;
    }
    if (k === 'laptop') {
      return `<rect class="mi-body" x="${x - 38}" y="${y - 28}" width="76" height="48" rx="6"/>`
        + `<rect class="mi-screen" x="${x - 31}" y="${y - 21}" width="62" height="34" rx="3"/>`
        + `<path class="mi-body" d="M${x - 48} ${y + 22}h96l-6 9h-84z"/>`;
    }
    return `<rect class="mi-body" x="${x - 42}" y="${y - 30}" width="84" height="54" rx="6"/>`
      + `<rect class="mi-screen" x="${x - 35}" y="${y - 23}" width="70" height="40" rx="3"/>`
      + `<path class="mi-body" d="M${x - 6} ${y + 24}h12v10h-12z M${x - 20} ${y + 34}h40v5h-40z"/>`;
  }

  // ---- drawing kit (a 400 x 240 picture; colours from CSS: .fa-c1/.fa-c2 the icon's two, fa-g the gradient) ----
  const rep = 'repeatCount="indefinite"';
  const fade = (dur, values, times, calc = 'linear') => `<animate attributeName="opacity" dur="${dur}s" ${rep} calcMode="${calc}" values="${values}" keyTimes="${times}"/>`;
  const shift = (dur, values, times = '') => `<animateTransform attributeName="transform" type="translate" dur="${dur}s" ${rep} values="${values}"${times ? ` keyTimes="${times}"` : ''}/>`;
  const spin = (dur, values, times = '') => `<animateTransform attributeName="transform" type="rotate" dur="${dur}s" ${rep} values="${values}"${times ? ` keyTimes="${times}"` : ''}/>`;
  const grow = (dur, values, times = '', begin = '0s') => `<animateTransform attributeName="transform" type="scale" dur="${dur}s" ${rep} begin="${begin}" values="${values}"${times ? ` keyTimes="${times}"` : ''}/>`;
  const along = (dur, values, times) => `<animateMotion dur="${dur}s" ${rep} calcMode="linear" values="${values}" keyTimes="${times}"/>`;
  // Appears at t (0..1 of a round) and stays until `until`.
  const from = (dur, t, until = 0.94) => fade(dur, '0;1;0', `0;${t};${until}`, 'discrete');

  function monitor(x, y, w, h) {
    const cx = x + w / 2;
    return `<rect class="fa-dev" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>`
      + `<rect class="fa-scr" x="${x + 6}" y="${y + 6}" width="${w - 12}" height="${h - 12}" rx="4"/>`
      + `<rect class="fa-dev" x="${cx - 7}" y="${y + h}" width="14" height="15"/>`
      + `<rect class="fa-dev" x="${cx - 26}" y="${y + h + 13}" width="52" height="6" rx="3"/>`;
  }
  function laptop(x, y, w, h) {
    return `<rect class="fa-dev" x="${x}" y="${y}" width="${w}" height="${h}" rx="7"/>`
      + `<rect class="fa-scr" x="${x + 5}" y="${y + 5}" width="${w - 10}" height="${h - 10}" rx="3"/>`
      + `<path class="fa-dev" d="M${x - 12} ${y + h + 2}h${w + 24}l-8 9h${-(w + 8)}z"/>`;
  }
  function phone(x, y, w, h) {
    return `<rect class="fa-dev" x="${x}" y="${y}" width="${w}" height="${h}" rx="${w * 0.2}"/>`
      + `<rect class="fa-scr" x="${x + 5}" y="${y + 10}" width="${w - 10}" height="${h - 20}" rx="${w * 0.08}"/>`;
  }
  function win(x, y, w, h) {
    return `<rect class="fa-paper fa-out" x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>`
      + `<path class="fa-bar" d="M${x} ${y + 13}h${w}"/>`
      + [0, 1, 2].map((i) => `<circle class="fa-c1" cx="${x + 9 + i * 8}" cy="${y + 7}" r="2.5"/>`).join('');
  }
  // A page, centred on 0,0.
  const doc = (s = 1) => `<g transform="scale(${s})"><path class="fa-paper fa-out" d="M-13 -17h18l8 8v26h-26z"/><path class="fa-fold" d="M5 -17v8h8"/>`
    + '<path class="fa-lines" d="M-7 -3h14M-7 3h14M-7 9h9"/></g>';
  const POINTER = 'M0 0V17l4.6-4.2 3 6.8 3-1.3-3-6.7H14z';
  // Someone from the shoulders up, standing on (x, y): facing us, or seen from behind.
  function person(x, y, s, { skin = 'sk1', hair = 'hr1', style = 'short', shirt = 'fa-c2', back = false, phones = false, headset = false } = {}) {
    let h = `<path class="${shirt}" d="M-31 0C-31-22-19-31 0-31S31-22 31 0z"/><rect class="${skin}" x="-6" y="-37" width="12" height="10" rx="3"/>`;
    h += `<circle class="${back ? hair : skin}" cx="0" cy="-49" r="14"/>`;
    if (!back) {
      if (style === 'long') h += `<path class="${hair}" d="M-15-48C-16-68 16-68 15-48L16-29H9V-46C4-55-4-55-9-46V-29H-16z"/>`;
      else h += `<path class="${hair}" d="M-14.5-50C-15-67 15-67 14.5-50C10-59-5-61-14.5-50z"/>`;
      if (style === 'bun') h += `<circle class="${hair}" cx="0" cy="-66" r="6.5"/>`;
    } else if (style === 'bun') h += `<circle class="${hair}" cx="0" cy="-65" r="6.5"/>`;
    if (phones || headset) h += '<path class="fa-band" d="M-17-50C-17-71 17-71 17-50"/><rect class="fa-c2" x="-21" y="-56" width="8" height="15" rx="3.5"/>';
    if (phones) h += '<rect class="fa-c2" x="13" y="-56" width="8" height="15" rx="3.5"/>';
    if (headset) h += '<path class="fa-band thin" d="M-18-43Q-18-33-6-34"/><circle class="fa-c2" cx="-5" cy="-34" r="2.6"/>';
    return `<g transform="translate(${x} ${y}) scale(${s})">${h}</g>`;
  }
  const sparkle = (x, y, s, dur, begin) => `<g transform="translate(${x} ${y}) scale(${s})"><g>${grow(dur, '0.4;1.15;0.4', '', begin)}`
    + '<path class="fa-c1" d="M0-9C1-2 2-1 9 0C2 1 1 2 0 9C-1 2-2 1-9 0C-2-1-1-2 0-9z"/></g></g>';

  // ---- one picture per feature, each its own scene ----
  const SCENES = {
    // Two screens, the pointer arcing from one onto the other along a dotted trail; the mouse below moves it.
    cursor: () => {
      const d = 'M118 96Q200 6 282 96';
      return '<ellipse class="fa-bg" cx="200" cy="120" rx="178" ry="104"/>'
        + monitor(34, 46, 142, 94) + monitor(224, 46, 142, 94)
        + `<path class="fa-dash" d="${d}"/>`
        + `<g><path class="fa-ptr" transform="scale(1.6)" d="${POINTER}"/><animateMotion dur="4s" ${rep} path="${d}" keyPoints="0;1;1;0;0" keyTimes="0;0.4;0.5;0.9;1" calcMode="linear"/></g>`
        + `<g>${shift(4, '-44 0;44 0;44 0;-44 0;-44 0', '0;0.4;0.5;0.9;1')}<g transform="translate(200 200)"><rect class="fa-paper fa-out" x="-15" y="-23" width="30" height="46" rx="15"/><path class="fa-band thin" d="M0-23v15"/></g></g>`;
    },
    // A big keyboard, keys going down one after another, the word appearing above.
    keyboard: () => {
      const word = t('Hello!');
      const keys = [[2, 5], [0, 2], [1, 8], [1, 8], [0, 8], [0, 9]]; // row, key: where each letter is
      let out = '<circle class="fa-bg" cx="200" cy="112" r="104"/>'
        + '<rect class="fa-paper fa-out" x="98" y="26" width="204" height="64" rx="16"/>'
        + '<rect class="fa-paper fa-out" x="52" y="128" width="296" height="92" rx="16"/>';
      for (let r = 0; r < 3; r++) {
        for (let k = 0; k < 11; k++) out += `<rect class="fa-key" x="${66 + k * 24.5 + r * 6}" y="${142 + r * 24}" width="20" height="18" rx="4"/>`;
      }
      [...word].forEach((ch, i) => {
        const t = (0.08 + i * 0.12).toFixed(2);
        const [r, k] = keys[i];
        out += `<rect class="fa-c2" x="${66 + k * 24.5 + r * 6}" y="${142 + r * 24}" width="20" height="18" rx="4" opacity="0">${fade(5, '0;1;0;0', `0;${t};${(+t + 0.07).toFixed(2)};1`, 'discrete')}</rect>`;
        out += `<text class="fa-type" x="${149 + i * 17}" y="70" opacity="0">${ch}${from(5, t)}</text>`;
      });
      const xs = [148, ...[...word].map((_, i) => 167 + i * 17)];
      const ts = ['0', ...[...word].map((_, i) => (0.08 + i * 0.12).toFixed(2))];
      out += `<rect class="fa-c2" x="148" y="46" width="3" height="30" rx="1.5"><animate attributeName="x" dur="5s" ${rep} calcMode="discrete" values="${xs.join(';')}" keyTimes="${ts.join(';')}"/>`
        + `<animate attributeName="opacity" dur="0.9s" ${rep} calcMode="discrete" values="1;0" keyTimes="0;0.5"/></rect>`;
      return out;
    },
    // A clipboard board in the middle: Copy on one side, the page goes across, Paste on the other.
    clipboard: (id) => {
      const pill = (x, label, vals, times) => `<g transform="translate(${x} 92)"><g>${grow(4, vals, times)}<rect class="fa-paper fa-out" x="-34" y="-13" width="68" height="26" rx="13"/><text class="fa-pill" y="4.5">${t(label)}</text></g></g>`;
      return '<ellipse class="fa-bg" cx="200" cy="124" rx="160" ry="100"/>'
        + laptop(30, 130, 76, 50) + laptop(294, 130, 76, 50)
        + `<rect fill="url(#fa-g-${id})" x="146" y="42" width="108" height="154" rx="16"/>`
        + '<rect class="fa-paper" x="160" y="64" width="80" height="116" rx="6"/>'
        + '<path class="fa-lines wide" d="M172 86h56M172 104h56M172 122h40M172 140h50M172 158h30"/>'
        + '<rect class="fa-dev" x="174" y="32" width="52" height="22" rx="7"/><circle class="fa-scr" cx="200" cy="37" r="4"/>'
        + `<g opacity="0">${doc(1)}${along(4, '68,152;68,152;200,118;200,118;332,152;332,152', '0;0.1;0.35;0.55;0.8;1')}${fade(4, '0;1;1;0;0', '0;0.08;0.82;0.9;1')}</g>`
        + pill(68, 'Copy', '0;1;1;0;0', '0;0.06;0.3;0.36;1') + pill(332, 'Paste', '0;0;1;1;0', '0;0.78;0.84;0.97;1');
    },
    // At a desk: the bell rings, the phone lights up, notifications slide onto the screen.
    notifications: (id) => {
      const card = (y, t) => `<g opacity="0">${fade(4.5, '0;0;1;1;0', `0;${t};${t + 0.06};0.92;1`)}<g>${shift(4.5, '34 0;34 0;0 0;0 0', `0;${t};${t + 0.06};1`)}`
        + `<rect class="fa-paper fa-out" x="224" y="${y}" width="102" height="28" rx="7"/><circle class="fa-c2" cx="238" cy="${y + 14}" r="6"/>`
        + `<path class="fa-lines" d="M250 ${y + 10}h62M250 ${y + 18}h44"/></g></g>`;
      return '<circle class="fa-bg" cx="232" cy="104" r="100"/>'
        + monitor(168, 40, 172, 110) + '<rect class="fa-desk" x="24" y="166" width="352" height="9" rx="4.5"/>'
        + phone(58, 104, 36, 62) + `<rect class="fa-c1" x="63" y="114" width="26" height="42" rx="3" opacity="0">${fade(4.5, '0;0;1;0.2;0', '0;0.04;0.08;0.5;1')}</rect>`
        + card(52, 0.08) + card(88, 0.3)
        + `<g transform="translate(338 30)"><g>${spin(4.5, '0;-18;15;-10;6;0;0', '0;0.04;0.08;0.12;0.16;0.2;1')}`
        + `<path fill="url(#fa-g-${id})" d="M-12 8C-12-7-8-14 0-14S12-7 12 8L15 12H-15z"/><circle class="fa-c2" cx="0" cy="15" r="3.6"/></g></g>`
        + '<path class="fa-band thin" d="M316 18q-5 8 0 16M360 18q5 8 0 16" opacity="0.8"/>'
        + person(122, 250, 1.3, { back: true, hair: 'hr2', shirt: 'fa-c2' });
    },
    // Someone in headphones, a level meter dancing beside them, notes floating up.
    audio: (id) => {
      let bars = '';
      const H = [[20, 56, 30, 70, 20], [44, 18, 62, 26, 44], [64, 36, 20, 54, 64], [30, 70, 44, 18, 30], [52, 24, 66, 38, 52], [24, 48, 28, 60, 24]];
      H.forEach((hs, i) => {
        const x = 236 + i * 20;
        bars += `<rect fill="url(#fa-g-${id})" x="${x}" y="${190 - hs[0]}" width="12" height="${hs[0]}" rx="6">`
          + `<animate attributeName="height" dur="1.6s" ${rep} values="${hs.join(';')}"/><animate attributeName="y" dur="1.6s" ${rep} values="${hs.map((h) => 190 - h).join(';')}"/></rect>`;
      });
      let notes = '';
      ['♪', '♫', '♪'].forEach((n, i) => {
        notes += `<text class="fa-note" opacity="0"><animateMotion dur="3s" ${rep} begin="-${i}s" values="${250 + i * 34},116;${262 + i * 34},36" keyTimes="0;1"/>`
          + `<animate attributeName="opacity" dur="3s" ${rep} begin="-${i}s" values="0;1;0" keyTimes="0;0.3;1"/>${n}</text>`;
      });
      return '<circle class="fa-bg" cx="205" cy="122" r="104"/>' + bars + notes
        + `<g>${spin(1.6, '-3 150 210;3 150 210;-3 150 210')}${person(150, 244, 1.75, { skin: 'sk3', hair: 'hr1', phones: true })}</g>`;
    },
    // A grid of apps; one of them opens out into its own big window.
    apps: (id) => {
      const fills = [`fill="url(#fa-g-${id})"`, 'class="fa-c1"', 'class="fa-c2"', 'class="fa-paper fa-out"'];
      let out = '<rect class="fa-bg" x="24" y="34" width="352" height="180" rx="48"/>';
      for (let i = 0; i < 9; i++) {
        if (i === 4) continue;
        out += `<rect ${fills[(i * 3) % 4]} x="${44 + (i % 3) * 38}" y="${62 + Math.floor(i / 3) * 38}" width="30" height="30" rx="9"/>`;
      }
      out += `<g transform="translate(97 115)"><g>${grow(4, '1;1.18;1;1', '0;0.06;0.12;1')}<rect fill="url(#fa-g-${id})" x="-15" y="-15" width="30" height="30" rx="9"/><circle class="fa-paper" r="6"/></g></g>`;
      out += `<g opacity="0"><rect fill="url(#fa-g-${id})" x="-15" y="-15" width="30" height="30" rx="9"/>${along(4, '97,115;97,115;290,122;290,122', '0;0.12;0.3;1')}${fade(4, '0;1;0;0', '0;0.12;0.31;1', 'discrete')}</g>`;
      out += `<g transform="translate(290 122)"><g opacity="0">${grow(4, '0.18;0.18;1;1;0.18', '0;0.3;0.42;0.9;1')}${fade(4, '0;0;1;1;0', '0;0.3;0.34;0.9;1')}`
        + win(-78, -60, 156, 120) + '<rect class="fa-c1" x="-66" y="-38" width="66" height="46" rx="5"/><path class="fa-lines wide" d="M10-34h54M10-22h40M10-10h50M-66 24h130M-66 38h90"/></g></g>';
      return out;
    },
    // One landscape across two screens side by side; a window slides over the seam.
    share: (id) => '<ellipse class="fa-bg" cx="200" cy="126" rx="182" ry="100"/>'
      + '<rect class="fa-sky" x="46" y="50" width="308" height="96"/><circle class="fa-sun" cx="300" cy="78" r="14"/>'
      + '<path class="fa-c1" d="M46 146V122Q100 100 150 118T260 110T354 116V146z" opacity="0.7"/>'
      + `<path fill="url(#fa-g-${id})" d="M46 146V132Q120 104 190 128T310 120T354 126V146z"/>`
      + '<rect class="fa-frame" x="42" y="46" width="158" height="104" rx="9"/><rect class="fa-frame" x="200" y="46" width="158" height="104" rx="9"/>'
      + '<rect class="fa-dev" x="114" y="154" width="14" height="14"/><rect class="fa-dev" x="95" y="166" width="52" height="6" rx="3"/>'
      + '<rect class="fa-dev" x="272" y="154" width="14" height="14"/><rect class="fa-dev" x="253" y="166" width="52" height="6" rx="3"/>'
      + `<g>${shift(5, '84 72;84 72;246 72;246 72;84 72', '0;0.15;0.5;0.85;1')}${win(0, 0, 70, 50)}<path class="fa-lines" d="M10 26h50M10 36h34"/>`
      + `<path class="fa-ptr" transform="translate(52 6)" d="${POINTER}"/></g>`,
    // This screen on the air: waves from it, its picture on a big screen, people watching.
    mirror: () => '<circle class="fa-bg" cx="272" cy="108" r="104"/>'
      + laptop(38, 96, 104, 68) + '<rect class="fa-c2" x="50" y="108" width="44" height="26" rx="3"/><rect class="fa-c1" x="100" y="120" width="30" height="32" rx="3"/>'
      + [0, 1, 2].map((i) => `<path class="fa-band" d="M${150 + i * 9} ${96 - i * 9}a${18 + i * 12} ${18 + i * 12} 0 0 1 ${8 + i * 5} ${22 + i * 14}" opacity="0"><animate attributeName="opacity" dur="1.8s" ${rep} begin="${i * 0.3}s" values="0;1;0" keyTimes="0;0.4;1"/></path>`).join('')
      + '<rect class="fa-dev" x="182" y="32" width="190" height="124" rx="9"/><rect class="fa-scr" x="188" y="38" width="178" height="112" rx="5"/>'
      + '<rect class="fa-dev" x="226" y="156" width="8" height="18"/><rect class="fa-dev" x="320" y="156" width="8" height="18"/>'
      + `<g opacity="0">${fade(3.6, '0;0;1;1;0', '0;0.2;0.32;0.92;1')}${win(200, 50, 154, 90)}`
      + '<rect class="fa-c2" x="212" y="72" width="62" height="38" rx="4"/><rect class="fa-c1" x="282" y="88" width="56" height="44" rx="4"/></g>'
      + `<circle class="fa-c2" cx="356" cy="46" r="4">${fade(1.2, '1;0.2;1', '0;0.5;1')}</circle>`
      + person(236, 250, 0.82, { back: true, hair: 'hr1', shirt: 'fa-c2' }) + person(318, 250, 0.82, { back: true, hair: 'hr3', style: 'bun', shirt: 'fa-c1' }),
    // The other device's desktop in a window here: someone at their desk, using it with the pointer.
    view: (id) => '<rect class="fa-bg" x="34" y="24" width="332" height="196" rx="98"/>'
      + monitor(92, 34, 220, 138)
      + '<path class="fa-dash" d="M326 66C320 84 304 74 292 66"/>' + monitor(326, 20, 52, 36)
      + win(110, 52, 184, 104) + '<rect class="fa-sky" x="111" y="66" width="182" height="89"/><circle class="fa-sun" cx="262" cy="88" r="10"/>'
      + `<path fill="url(#fa-g-${id})" d="M111 155V130Q160 112 200 128T293 124V155z"/>`
      + '<rect class="fa-paper" x="120" y="74" width="14" height="12" rx="3"/><rect class="fa-paper" x="120" y="92" width="14" height="12" rx="3"/>'
      + `<circle class="fa-c2" cx="222" cy="102" r="0" opacity="0.8"><animate attributeName="r" dur="4.5s" ${rep} values="0;0;14;14" keyTimes="0;0.3;0.42;1"/>${fade(4.5, '0;0;0.8;0;0', '0;0.3;0.31;0.42;1')}</circle>`
      + `<g>${along(4.5, '160,134;222,102;222,102;180,120;160,134', '0;0.3;0.5;0.8;1')}<path class="fa-ptr" d="${POINTER}"/></g>`
      + person(76, 252, 1.15, { back: true, hair: 'hr2', shirt: 'fa-c2' }),
    // Two folders, the screen's edge between them: pages dragged over from one to the other.
    files: (id) => {
      const folder = (x, open) => `<g transform="translate(${x} 150)"><path class="fa-c2" d="M-52-36h34l9-10h61v84h-104z"/>`
        + `<path fill="url(#fa-g-${id})" d="${open ? 'M-58-14h116l-8 52h-100z' : 'M-52-24h104v62h-104z'}"/></g>`;
      const page = (begin, ptr) => `<g opacity="0">${doc(1.15)}${ptr ? `<path class="fa-ptr" transform="translate(8 6)" d="${POINTER}"/>` : ''}`
        + `<animateMotion dur="4s" ${rep} begin="${begin}" path="M95 112Q200 4 305 122" keyPoints="0;0;1;1" keyTimes="0;0.15;0.6;1" calcMode="linear"/>`
        + `<animate attributeName="opacity" dur="4s" ${rep} begin="${begin}" values="0;1;1;0;0" keyTimes="0;0.15;0.6;0.66;1"/></g>`;
      return '<ellipse class="fa-bg" cx="200" cy="132" rx="172" ry="92"/><path class="fa-dash" d="M200 26V214"/>'
        + folder(95, false) + page('-2s', false) + page('0s', true) + folder(305, true);
    },
    // A terminal: the command typed, the other computer answering.
    terminal: (id) => {
      const cmd = 'ssh twindesk';
      let out = '<circle class="fa-bg" cx="200" cy="120" r="108"/>'
        + `<rect fill="url(#fa-g-${id})" class="fa-termwin" x="54" y="32" width="292" height="176" rx="12"/>`
        + '<path class="fa-termbar" d="M54 44a12 12 0 0 1 12-12h268a12 12 0 0 1 12 12v12H54z"/>'
        + [0, 1, 2].map((i) => `<circle class="fa-termdot" cx="${70 + i * 12}" cy="44" r="3.5"/>`).join('')
        + '<text class="fa-mono dim" x="76" y="86">$</text>';
      [...cmd].forEach((ch, i) => {
        out += `<text class="fa-mono" x="${92 + i * 9}" y="86" opacity="0">${ch === ' ' ? '&#160;' : ch}${from(6, (0.05 + i * 0.035).toFixed(3))}</text>`;
      });
      out += `<text class="fa-mono dim" x="76" y="112" opacity="0">${t('Connected to the other computer')}${from(6, '0.55')}</text>`
        + `<text class="fa-mono dim" x="76" y="138" opacity="0">~ $${from(6, '0.66')}</text>`;
      const xs = ['92', ...[...cmd].map((_, i) => 101 + i * 9), '112'];
      const ys = ['74', ...[...cmd].map(() => 74), '126'];
      const ts = ['0', ...[...cmd].map((_, i) => (0.05 + i * 0.035).toFixed(3)), '0.66'];
      out += `<rect class="fa-termcur" x="92" y="74" width="8" height="15"><animate attributeName="x" dur="6s" ${rep} calcMode="discrete" values="${xs.join(';')}" keyTimes="${ts.join(';')}"/>`
        + `<animate attributeName="y" dur="6s" ${rep} calcMode="discrete" values="${ys.join(';')}" keyTimes="${ts.join(';')}"/>`
        + `<animate attributeName="opacity" dur="0.9s" ${rep} calcMode="discrete" values="1;0" keyTimes="0;0.5"/></rect>`;
      return out + '<g transform="translate(318 176)"><rect class="fa-dev" x="-26" y="-20" width="52" height="34" rx="5"/><rect class="fa-scr" x="-22" y="-16" width="44" height="26" rx="2"/>'
        + '<rect class="fa-dev" x="-4" y="14" width="8" height="8"/><rect class="fa-dev" x="-14" y="20" width="28" height="4" rx="2"/></g>';
    },
    // A phone on a cable to a drive here: its files go down the cable, the drive's light flickers.
    mount: (id) => {
      const cable = 'M91 178C91 226 196 222 222 168';
      let out = '<ellipse class="fa-bg" cx="206" cy="126" rx="166" ry="98"/>' + phone(56, 40, 70, 138);
      for (let i = 0; i < 6; i++) out += `<g transform="translate(${70 + (i % 2) * 28} ${62 + Math.floor(i / 2) * 32})"><path class="fa-c2" d="M0 0h8l3-3h9v17h-20z"/><path fill="url(#fa-g-${id})" d="M0 3h20v14h-20z"/></g>`;
      out += `<path class="fa-cable" d="${cable}"/>`;
      for (let i = 0; i < 3; i++) out += `<circle class="fa-c2" r="4.5"><animateMotion dur="2.4s" ${rep} begin="-${i * 0.8}s" path="${cable}"/></circle>`;
      out += `<rect fill="url(#fa-g-${id})" x="214" y="124" width="140" height="66" rx="16"/><path class="fa-slot" d="M234 170h64"/>`
        + `<circle class="fa-led" cx="332" cy="170" r="4.5">${fade(0.6, '1;0.25;1', '0;0.5;1')}</circle>`
        + `<g>${shift(2.4, '0 0;0 -8;0 0')}<g transform="translate(284 84)"><path class="fa-c2" d="M-22-14h14l5-6h25v34h-44z"/><path class="fa-paper fa-out" d="M-26-6h52l-4 26h-44z"/></g></g>`;
      return out;
    },
    // Someone in a headset; the phone beside them rings, the answer button pulsing.
    calls: (id) => '<circle class="fa-bg" cx="204" cy="118" r="104"/>'
      + `<g>${spin(2.4, '0 286 120;-5 286 120;5 286 120;-5 286 120;5 286 120;0 286 120;0 286 120', '0;0.05;0.1;0.15;0.2;0.25;1')}`
      + phone(250, 50, 72, 140) + '<circle class="fa-c1" cx="286" cy="90" r="16"/><circle class="fa-paper" cx="286" cy="85" r="6"/><path class="fa-paper" d="M275 100a11 9 0 0 1 22 0z"/>'
      + '<path class="fa-lines" d="M270 118h32M276 128h20"/>'
      + `<g transform="translate(286 160)"><g>${grow(1.2, '1;1.14;1')}<circle fill="url(#fa-g-${id})" r="14"/>`
      + '<path class="fa-paper" d="M-6-5c0 7 4 11 11 11l2-3.5-3.5-2.2-2 1.4c-2-1-4-3-5-5l1.4-2-2.2-3.5z"/></g></g></g>'
      + [0, 1].map((i) => `<path class="fa-band" d="M${238 - i * 10} ${70 - i * 6}q-${8 + i * 4} ${14 + i * 4} 0 ${28 + i * 10}M${334 + i * 10} ${70 - i * 6}q${8 + i * 4} ${14 + i * 4} 0 ${28 + i * 10}" opacity="0"><animate attributeName="opacity" dur="1.2s" ${rep} begin="${i * 0.3}s" values="0;1;0" keyTimes="0;0.5;1"/></path>`).join('')
      + person(132, 246, 1.62, { skin: 'sk2', hair: 'hr1', style: 'long', shirt: 'fa-c2', headset: true })
      + [0, 1, 2].map((i) => `<path class="fa-band thin" d="M${176 + i * 7} ${150 - i * 5}q${6 + i * 3} ${8 + i * 4} 0 ${16 + i * 10}" opacity="0"><animate attributeName="opacity" dur="1.5s" ${rep} begin="${i * 0.25}s" values="0;1;0" keyTimes="0;0.5;1"/></path>`).join(''),
    // A conversation: bubbles in turn from two people, then the other one typing.
    messages: (id) => {
      const bubble = (x, y, w, mine, t) => `<g opacity="0">${fade(6, '0;0;1;1;0', `0;${t};${t + 0.04};0.95;1`)}<g>${shift(6, '0 10;0 10;0 0;0 0', `0;${t};${t + 0.04};1`)}`
        + `<rect ${mine ? `fill="url(#fa-g-${id})"` : 'class="fa-paper fa-out"'} x="${x}" y="${y}" width="${w}" height="34" rx="17"/>`
        + `<path class="${mine ? 'fa-wlines' : 'fa-lines'}" d="M${x + 16} ${y + 13}h${w - 34}M${x + 16} ${y + 22}h${w - 56}"/></g></g>`;
      const face = (x, y, skin, hair, style) => `<g transform="translate(${x} ${y})"><circle class="fa-c1" r="15"/>${person(0, 14, 0.36, { skin, hair, style, shirt: 'fa-c2' })}</g>`;
      return '<rect class="fa-bg" x="64" y="16" width="272" height="214" rx="44"/>'
        + face(92, 60, 'sk1', 'hr3', 'bun') + face(316, 108, 'sk4', 'hr1', 'short')
        + bubble(114, 42, 132, false, 0.04) + bubble(160, 90, 138, true, 0.22) + bubble(114, 138, 104, false, 0.42)
        + `<g opacity="0">${fade(6, '0;0;1;1;0', '0;0.6;0.64;0.95;1')}<rect class="fa-paper fa-out" x="114" y="184" width="66" height="30" rx="15"/>`
        + [0, 1, 2].map((i) => `<circle class="fa-c2" cx="${133 + i * 14}" cy="199" r="4"><animateTransform attributeName="transform" type="translate" dur="0.9s" ${rep} begin="${i * 0.15}s" values="0 0;0 -5;0 0;0 0" keyTimes="0;0.2;0.4;1"/></circle>`).join('')
        + '</g>';
    },
    // Prints fanned out, the top one floating up; a phone's picture flies onto the pile.
    media: (id) => {
      const print = (x, y, r) => `<g transform="translate(${x} ${y}) rotate(${r})"><rect class="fa-paper fa-out" x="-46" y="-54" width="92" height="108" rx="5"/>`
        + '<rect class="fa-sky" x="-38" y="-46" width="76" height="70"/><circle class="fa-sun" cx="18" cy="-28" r="9"/>'
        + `<path fill="url(#fa-g-${id})" d="M-38 24L-12-10L6 10L18-2L38 24z"/></g>`;
      return '<circle class="fa-bg" cx="200" cy="120" r="106"/>'
        + print(146, 128, -14) + print(254, 128, 12)
        + `<g>${shift(3.2, '0 0;0 -9;0 0')}${print(200, 116, -2)}</g>`
        + phone(316, 140, 44, 82) + [0, 1, 2, 3].map((i) => `<rect class="${i % 2 ? 'fa-c1' : 'fa-c2'}" x="${323 + (i % 2) * 15}" y="${153 + Math.floor(i / 2) * 15}" width="13" height="13" rx="2"/>`).join('')
        + `<rect class="fa-c2" x="-7" y="-7" width="14" height="14" rx="2" opacity="0">${along(3.2, '330,160;330,160;214,104;214,104', '0;0.5;0.8;1')}${fade(3.2, '0;0;1;1;0;0', '0;0.49;0.5;0.8;0.82;1')}</rect>`
        + sparkle(94, 64, 1, 1.6, '0s') + sparkle(308, 46, 0.8, 1.6, '0.8s');
    },
    // The phone's folders in its own list; files circling round it, out and back in.
    pfiles: (id) => {
      const orbit = 'M48 124A152 70 0 1 1 352 124A152 70 0 1 1 48 124';
      let out = '<circle class="fa-bg" cx="200" cy="120" r="104"/>'
        + `<path class="fa-orbit" d="${orbit}"/>`;
      for (let i = 0; i < 3; i++) out += `<g>${doc(0.95)}<animateMotion dur="7s" ${rep} begin="-${((i * 7) / 3).toFixed(2)}s" path="${orbit}"/></g>`;
      out += phone(158, 22, 84, 172);
      for (let i = 0; i < 5; i++) {
        const y = 46 + i * 27;
        out += `<g transform="translate(170 ${y})"><path class="fa-c2" d="M0 0h6l2.5-2.5h7.5v13h-16z"/><path fill="url(#fa-g-${id})" d="M0 2.5h16v10.5h-16z"/></g>`
          + `<path class="fa-mutel" d="M194 ${y + 7}h${30 - (i % 2) * 10}"/>`;
      }
      return out;
    },
    // A webcam, its picture flowing across onto the other screen: someone there, live.
    camera: (id) => {
      const flow = 'M138 102Q190 62 236 94';
      let out = '<ellipse class="fa-bg" cx="206" cy="122" rx="174" ry="100"/>'
        + '<rect class="fa-dev" x="91" y="124" width="12" height="38"/><rect class="fa-dev" x="62" y="158" width="70" height="7" rx="3.5"/>'
        + `<rect fill="url(#fa-g-${id})" x="56" y="76" width="82" height="54" rx="27"/>`
        + '<circle class="fa-dev" cx="97" cy="103" r="18"/><circle class="fa-scr" cx="97" cy="103" r="11"/><circle class="fa-c1" cx="92" cy="98" r="3.5"/>'
        + `<circle class="fa-band thin" cx="97" cy="103" r="18" opacity="0"><animate attributeName="r" dur="2s" ${rep} values="18;34"/>${fade(2, '0.9;0', '0;1')}</circle>`
        + `<path class="fa-dash" d="${flow}"/>`;
      for (let i = 0; i < 3; i++) out += `<circle class="fa-c2" r="4"><animateMotion dur="2.1s" ${rep} begin="-${i * 0.7}s" path="${flow}"/></circle>`;
      out += monitor(222, 40, 150, 100) + '<rect class="fa-sky" x="228" y="46" width="138" height="88" rx="4"/>'
        + `<g>${spin(3, '-2 297 134;2 297 134;-2 297 134')}${person(297, 134, 1.05, { skin: 'sk2', hair: 'hr2', style: 'long', shirt: 'fa-c2' })}</g>`
        + `<circle class="fa-paper" cx="354" cy="58" r="4.5">${fade(1.2, '1;0.2;1', '0;0.5;1')}</circle>`;
      return out;
    },
    // The phone as a touchpad: a finger moves on it, the pointer follows on the computer and clicks.
    remote: (id) => {
      const t = '0;0.4;0.5;0.85;1';
      return '<circle class="fa-bg" cx="206" cy="120" r="106"/>'
        + phone(52, 40, 88, 164) + '<rect class="fa-paper fa-out" x="64" y="56" width="64" height="92" rx="9"/>'
        + `<rect fill="url(#fa-g-${id})" x="64" y="154" width="31" height="30" rx="7"/><rect fill="url(#fa-g-${id})" x="97" y="154" width="31" height="30" rx="7"/>`
        + `<circle class="fa-c2" r="9" opacity="0.85">${along(4.5, '78,134;114,80;114,80;88,116;78,134', t)}</circle>`
        + [0, 1, 2].map((i) => `<path class="fa-band" d="M${150 + i * 9} ${84 - i * 8}a${16 + i * 11} ${16 + i * 11} 0 0 1 ${8 + i * 5} ${22 + i * 13}" opacity="0"><animate attributeName="opacity" dur="1.8s" ${rep} begin="${i * 0.3}s" values="0;1;0" keyTimes="0;0.4;1"/></path>`).join('')
        + monitor(196, 44, 176, 112) + win(276, 58, 82, 58) + '<rect class="fa-c1" x="288" y="80" width="58" height="24" rx="5"/>'
        + `<circle class="fa-c2" cx="318" cy="92" r="0" opacity="0.8"><animate attributeName="r" dur="4.5s" ${rep} values="0;0;14;14" keyTimes="0;0.4;0.5;1"/>${fade(4.5, '0;0;0.8;0;0', '0;0.4;0.41;0.5;1')}</circle>`
        + `<g>${along(4.5, '214,132;318,92;318,92;238,118;214,132', t)}<path class="fa-ptr" d="${POINTER}"/></g>`;
    },
    // A page open on the phone goes across onto the computer, where it carries on in a window.
    rezume: (id) => {
      const flow = 'M140 108Q190 66 238 96';
      return '<ellipse class="fa-bg" cx="206" cy="122" rx="174" ry="100"/>'
        + phone(52, 40, 88, 164) + '<rect class="fa-paper fa-out" x="64" y="56" width="64" height="92" rx="9"/>'
        + `<rect fill="url(#fa-g-${id})" x="70" y="64" width="52" height="30" rx="5"/>`
        + '<rect class="fa-c1" x="70" y="102" width="52" height="6" rx="3"/><rect class="fa-c1" x="70" y="114" width="36" height="6" rx="3"/>'
        + `<path class="fa-dash" d="${flow}"/>`
        + `<rect fill="url(#fa-g-${id})" x="-11" y="-7" width="22" height="14" rx="3"><animateMotion dur="2.4s" ${rep} path="${flow}"/>${fade(2.4, '0;1;1;0', '0;0.15;0.85;1')}</rect>`
        + monitor(222, 40, 150, 100) + win(236, 52, 122, 76)
        + `<rect fill="url(#fa-g-${id})" x="246" y="66" width="102" height="30" rx="5">${fade(2.4, '0.35;0.35;1;1', '0;0.7;0.85;1')}</rect>`
        + '<rect class="fa-c1" x="246" y="102" width="70" height="6" rx="3"/><rect class="fa-c1" x="246" y="112" width="50" height="6" rx="3"/>';
    },
  };
  // Tab ids -> scene: the Mac's screen tabs and the PC apps' are called differently.
  const SCENE = {
    cursor: 'cursor', keyboard: 'keyboard', clipboard: 'clipboard', notifications: 'notifications', audio: 'audio', apps: 'apps',
    share: 'share', receive: 'view', 'mac-pc': 'view', 'pc-mac': 'mirror', files: 'files', terminal: 'terminal', mount: 'mount',
    calls: 'calls', messages: 'messages', media: 'media', pfiles: 'pfiles', camera: 'camera', remote: 'remote', rezume: 'rezume',
  };

  // The feature's name and what it does, the same for every device.
  const TEXT = {
    cursor: ['Cursor sharing', 'Push the pointer past the edge of the screen and it carries on onto the other device. One mouse or trackpad for both.'],
    keyboard: ['Keyboard sharing', 'This keyboard types on whichever device the pointer is on, shortcuts included.'],
    clipboard: ['Clipboard sync', 'Copy something on one device and paste it on the other. It goes across by itself.'],
    notifications: ['Notification sync', 'Notifications from the other device show up on this one, and the other way round.'],
    audio: ['Sound sharing', 'Play one device’s sound on the other’s speakers or headphones.'],
    apps: ['App sharing', 'Open an app of the other device: it runs there and shows up here in a window of its own.'],
    share: ['Second screen', 'This screen becomes a second screen for the other device: move windows across onto it.'],
    receive: ['Remote screen', 'The other device’s screen in a window here, to see it and use it from here.'],
    'mac-pc': ['Remote screen', 'The other device’s screen in a window here, to see it and use it from here.'],
    'pc-mac': ['Screen sharing', 'This screen in a window on the other device, to show it or use it from there.'],
    files: ['File sharing', 'Drag files across the screen edge, take in files sent your way, or share a folder.'],
    terminal: ['Remote terminal', 'Open a terminal on the other computer from this one. No passwords needed.'],
    mount: ['Phone drive', 'The phone’s storage as a drive here, to open and copy its files like any other folder.'],
    calls: ['Phone calls', 'Answer and make your phone’s calls on this computer, and talk through it.'],
    messages: ['Text messages', 'Read and send your phone’s texts here.'],
    media: ['Phone photos', 'See your phone’s photos and videos and copy them here.'],
    pfiles: ['Phone files', 'Browse the phone’s storage and copy files to and from it, no cable needed.'],
    camera: ['Camera sharing', 'The other device’s camera here: see its picture, or pick it as a camera in any app.'],
    remote: ['Phone as a remote', 'Use the phone as this computer’s touchpad, keyboard or gamepad.'],
    rezume: ['ReZume', 'Like Handoff on Apple devices: go on here with the page, document or phone app you were using on the other device, and the other way round.'],
  };

  const has = (id) => id in SCENE;

  const KEY = 'twindesk.featureArt.dismissed';
  function dismissedList() {
    try {
      const l = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(l) ? l : [];
    } catch (e) {
      return [];
    }
  }
  const dismissed = (id) => dismissedList().includes(id);
  function dismiss(id) {
    try {
      localStorage.setItem(KEY, JSON.stringify([...new Set([...dismissedList(), id])]));
    } catch (e) { /* not kept: it comes back next time */ }
  }

  function create(id, { color, keep = false, onDismiss }) {
    const el = document.createElement('div');
    el.className = 'feature-art';
    el.hidden = true;
    const [c1, c2] = String(color || '').match(/#[0-9a-f]{3,8}\b/gi) || [];
    if (c1) el.style.setProperty('--fa1', c1); // CSSOM: the CSP allows it, style attributes it doesn't
    if (c1) el.style.setProperty('--fa2', c2 || c1);
    let gone = keep && dismissed(id); // dismissed (before, when kept), or now even where that can't be kept
    let built = false;
    function build() {
      built = true;
      const hero = document.createElement('div');
      hero.className = 'fa-hero';
      const pic = document.createElement('div');
      pic.className = 'fa-pic';
      pic.setAttribute('aria-hidden', 'true');
      pic.innerHTML = `<svg viewBox="0 0 400 240"><defs><linearGradient id="fa-g-${id}" x1="0" y1="0" x2="0.4" y2="1">`
        + `<stop class="fa-s1" offset="0"/><stop class="fa-s2" offset="1"/></linearGradient></defs>${SCENES[SCENE[id]](id)}</svg>`;
      const svg = pic.firstChild;
      if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches && svg.pauseAnimations) {
        svg.pauseAnimations(); // one still frame, part way through
        svg.setCurrentTime(1.6);
      }
      const [head, text] = TEXT[id];
      const h = document.createElement('h2');
      h.textContent = t(head);
      const p = document.createElement('p');
      p.textContent = t(text);
      const ok = document.createElement('button');
      ok.className = 'btn';
      ok.textContent = t('Dismiss');
      ok.title = t('Show the settings');
      ok.onclick = () => {
        gone = true;
        if (keep) dismiss(id);
        el.hidden = true;
        onDismiss();
      };
      hero.append(pic, h, p, ok);
      el.append(hero);
    }
    return {
      el,
      set(show) {
        show = !!show && !gone;
        if (show && !built) build();
        el.hidden = !show;
      },
    };
  }

  window.FeatureArt = { FREE, has, device, dismissed, create };
})();
