// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Debug tab (Multi-device; Windows, Linux and the Mac): any device of the mesh from this one (docs/debug.md).
// This computer: which devices may debug it, Allow any command, its own verbose log. Devices: every
// device of the mesh (direct or through another), whether it lets us in, and for the one picked its live
// status, verbose log, logs (whole, the end, a search), a screenshot, the diagnostics, a command, a
// restart. Activity: what was asked, both ways. The work is shared/meshdebug.js, through api.debugAsk.
//
// Asks only while this page is on screen: hello of each device every HELLO_MS, the picked device's status
// every STATUS_MS (BLE_STATUS_MS through Bluetooth). A device that doesn't answer (an older app, a phone)
// is asked again only after a while (meshdebug.js).
'use strict';

UI.tab({
  id: 'debug',
  order: 96,
  title: I18n.t('Debug'),
  heading: I18n.t('Debug · Every device of the mesh'),
  color: 'linear-gradient(#8e8e93, #48484a)',
  icon: 'debug',
  desc: I18n.t('Status, logs, screenshots and diagnostics of any device'),
  bottom: true,
  // Someone debugging this computer right now: the tab says so in the sidebar.
  badge: (s) => (s && s.debug && s.debug.debuggedBy && s.debug.debuggedBy.length ? 'on' : ''),
  build(body, page) {
    const { api, el } = UI;
    const HELLO_MS = 30000;
    const STATUS_MS = 5000;
    const BLE_STATUS_MS = 30000;
    const isPhone = (os) => os === 'android' || os === 'ios';
    let last = null; // the last state
    let me = ''; // this computer's id
    const hellos = new Map(); // id -> {at, ok, data, error}
    let picked = null; // the device whose card is open
    let statusTimer = null;
    let helloTimer = null;

    const onScreen = () => !page.hidden && !document.hidden;
    const peersOf = (s) => (s.peers || []).filter((p) => p && p.id && p.id !== me);
    const nameOf = (id) => {
      if (id === me) return (last && (last.device ? last.device.name : last.macName)) || I18n.t('This computer');
      const p = last && peersOf(last).find((x) => x.id === id);
      return p ? p.name || id.slice(0, 8) : id.slice(0, 8);
    };
    const pre = (cls = '') => el('pre', { class: `debug-out ${cls}`.trim() });
    const say = (box, text) => { box.textContent = text || ''; box.hidden = !text; };
    const errText = (e) => ({
      'not allowed': I18n.t('That device doesn’t let this computer debug it (its Debug tab)'),
      'no answer': I18n.t('No answer: an older TwinDesk, or a phone'),
      unreachable: I18n.t('Not reachable from here now'),
      bluetooth: I18n.t('Connected through Bluetooth: too slow for this'),
      'any command is off': I18n.t('Allow any command is off on that device'),
      timeout: I18n.t('It took too long'),
    }[e] || e || I18n.t('It didn’t work'));

    // ---- This computer ----
    const beingNote = UI.note('warn', '', { literal: true });
    const allowBox = el('div', { class: 'debug-allow' });
    const anySw = UI.switch((v) => api.setDebug({ any: v }), { label: I18n.t('Allow any command') });
    const anyRow = UI.row(I18n.t('Allow any command'), '', [anySw]);
    const vTag = UI.select([], () => {});
    const vTime = UI.segmented([
      { value: 0, label: I18n.t('Off') }, { value: 15, label: I18n.t('15 min') }, { value: 60, label: I18n.t('1 h') }, { value: 120, label: I18n.t('2 h') },
    ], (m) => api.debugAsk('self', 'verbose', { tags: [vTag.el.value || 'all'], minutes: m })); // main pushes the state
    const vRow = UI.row(I18n.t('Verbose log here'), '', [vTag, vTime]);
    const logsBtn = UI.button(I18n.t('Open log folder'), () => api.openLink('logs'), 'small');
    const thisCard = UI.card(I18n.t('This computer'), [
      beingNote,
      UI.row(I18n.t('Let these devices debug this computer'), I18n.t('They can read its status and logs, take screenshots and run the diagnostics. Off for every device until you turn it on'), []),
      allowBox,
      anyRow,
      vRow,
      UI.row(I18n.t('Logs'), I18n.t('What Debug fetches from a device is kept beside its logs, under peers'), [logsBtn]),
    ]);

    function drawThis(s) {
      const d = s.debug || {};
      const by = d.debuggedBy || [];
      beingNote.set(by.length ? I18n.t('{names} debugged this computer in the last 2 minutes', { names: by.join(', ') }) : '');
      const allow = new Set(d.allow || []);
      const devs = peersOf(s).filter((p) => !isPhone(p.os));
      const key = JSON.stringify(devs.map((p) => [p.id, p.name, allow.has(p.id)]));
      if (allowBox.dataset.key !== key) {
        allowBox.dataset.key = key;
        allowBox.replaceChildren(...(devs.length ? devs.map((p) => {
          const sw = UI.switch((v) => {
            const next = new Set((last.debug && last.debug.allow) || []);
            if (v) next.add(p.id); else next.delete(p.id);
            api.setDebug({ allow: [...next] });
          }, { label: p.name });
          sw.set(allow.has(p.id));
          const row = UI.row(p.name || p.id.slice(0, 8), p.state === 'via' ? I18n.t('Through {names}', { names: (p.via || []).join(', ') }) : '', [sw], { literal: true });
          row.prepend(UI.osIcon(p.os));
          row.classList.add('with-ico');
          return row;
        }) : [UI.note('info', I18n.t('No other computer is paired yet'))]));
      }
      const until = d.anyCommandUntil || 0;
      anySw.set(until > Date.now());
      anyRow.setHint(until > Date.now()
        ? I18n.t('On for {count} more min. A device you let in can run any command here, as you', { count: Math.max(1, Math.round((until - Date.now()) / 60000)) })
        : I18n.t('Off: the devices you let in run the fixed diagnostics only. On, it turns itself off after an hour'));
      const tags = ['all', ...(d.tags || [])];
      vTag.options(tags.map((t) => ({ value: t, label: t === 'all' ? I18n.t('Everything') : t })));
      const v = d.verbose || { tags: [], until: 0 };
      const on = v.tags && v.tags.length && v.until > Date.now();
      if (on) vTag.set(v.tags[0]);
      vTime.set(on ? null : 0);
      vRow.setHint(on ? I18n.t('{tags}, for {count} more min', { tags: v.tags.join(', '), count: Math.max(1, Math.round((v.until - Date.now()) / 60000)) })
        : I18n.t('More detail in this computer’s log for a while: links that go silent, the input lane, quiet links, messages'));
    }

    // ---- Devices ----
    const devList = el('div', { class: 'debug-devs' });
    const devCard = UI.card(I18n.t('Devices'), [devList]);

    function stateOf(p) {
      const h = hellos.get(p.id);
      if (isPhone(p.os)) return { pill: 'muted', text: I18n.t('Phone: not yet') };
      if (!h) return { pill: 'muted', text: I18n.t('Asking…') };
      if (!h.ok) return { pill: 'bad', text: errText(h.error) };
      if (!h.data.allowed) return { pill: 'bad', text: I18n.t('Doesn’t let this computer in') };
      return { pill: 'good', text: I18n.t('Lets this computer in') };
    }

    function drawDevices(s) {
      const devs = peersOf(s);
      const rows = devs.map((p) => {
        const st = stateOf(p);
        const h = hellos.get(p.id);
        const bits = [];
        if (p.state === 'via') bits.push(I18n.t('through {names}', { names: (p.via || []).join(', ') }));
        else if (p.connected) bits.push(h && h.ok && h.data.transport === 'ble' ? 'Bluetooth' : p.rtt != null ? `${p.rtt} ms` : I18n.t('connected'));
        else bits.push(I18n.t('not connected'));
        if (h && h.ok && h.data.version) bits.push(`TwinDesk ${h.data.version}`);
        const open = UI.button(picked === p.id ? I18n.t('Close') : I18n.t('Debug'), () => pick(picked === p.id ? null : p.id), 'small');
        open.disabled = !(h && h.ok && h.data.allowed) && picked !== p.id;
        const row = UI.row(p.name || p.id.slice(0, 8), bits.join(', '), [el('span', { class: `pill ${st.pill}`, text: st.text }), open], { literal: true });
        row.prepend(UI.osIcon(p.os));
        row.classList.add('with-ico');
        return row;
      });
      const selfBtn = UI.button(picked === me ? I18n.t('Close') : I18n.t('Debug'), () => pick(picked === me ? null : me), 'small');
      const selfRow = UI.row(nameOf(me), I18n.t('This computer'), [selfBtn], { literal: true });
      devList.replaceChildren(selfRow, ...rows);
    }

    async function helloAll() {
      if (!last || !onScreen()) return;
      for (const p of peersOf(last)) {
        if (isPhone(p.os)) continue;
        const r = await api.debugAsk(p.id, 'hello', {});
        hellos.set(p.id, { at: Date.now(), ok: !!(r && r.ok), data: (r && r.data) || {}, error: r && r.error });
      }
      if (last) { drawDevices(last); drawPicked(); }
    }

    // ---- the picked device ----
    const pickTitle = el('span');
    const statusBox = pre();
    const statusSw = UI.switch(() => schedule(), { label: I18n.t('Keep it up to date') });
    statusSw.set(true);
    const statusRow = UI.row(I18n.t('Status'), '', [statusSw, UI.button(I18n.t('Now'), () => refreshStatus(), 'small')]);

    const pvTag = UI.select([], () => {});
    const pvTime = UI.segmented([
      { value: 0, label: I18n.t('Off') }, { value: 15, label: I18n.t('15 min') }, { value: 60, label: I18n.t('1 h') }, { value: 120, label: I18n.t('2 h') },
    ], async (m) => {
      const r = await api.debugAsk(picked, 'verbose', { tags: [pvTag.el.value || 'all'], minutes: m });
      pvRow.setHint(r.ok ? (r.data.tags && r.data.tags.length ? I18n.t('On: {tags}', { tags: r.data.tags.join(', ') }) : I18n.t('Off')) : errText(r.error));
    });
    const pvRow = UI.row(I18n.t('Verbose log'), '', [pvTag, pvTime]);

    const logFile = UI.select([], () => {});
    const findIn = el('input', { type: 'search', placeholder: I18n.t('Find'), class: 'debug-find' });
    const logBox = pre();
    const logShow = UI.button(I18n.t('Show file'), () => logShow.path && api.debugShow(logShow.path), 'small');
    logShow.hidden = true;
    const logGo = (args, btn) => async () => {
      btn.disabled = true;
      const r = await api.debugAsk(picked, 'log', { file: logFile.el.value || 'TwinDesk.log', ...args });
      btn.disabled = false;
      if (!r.ok) { say(logBox, errText(r.error)); logShow.hidden = true; return; }
      const head = args.grep ? I18n.t('{count} lines with “{text}”', { count: r.data.lines, text: args.grep }) : `${r.data.file}: ${UI.bytes(r.size || 0)} of ${UI.bytes(r.data.size)}`;
      say(logBox, `${head}\n${r.path ? r.path + '\n' : ''}\n${r.text || ''}`);
      logBox.scrollTop = logBox.scrollHeight;
      logShow.path = r.path;
      logShow.hidden = !r.path;
    };
    const wholeBtn = UI.button(I18n.t('Whole'), null, 'small');
    const tailBtn = UI.button(I18n.t('Last 1 MB'), null, 'small');
    const findBtn = UI.button(I18n.t('Find'), null, 'small');
    wholeBtn.onclick = logGo({}, wholeBtn);
    tailBtn.onclick = logGo({ tail: 1024 * 1024 }, tailBtn);
    findBtn.onclick = () => findIn.value.trim() && logGo({ grep: findIn.value.trim() }, findBtn)();
    findIn.onkeydown = (e) => { if (e.key === 'Enter') findBtn.onclick(); };
    const logRow = UI.row(I18n.t('Logs'), '', [logFile, wholeBtn, tailBtn]);
    const findRow = UI.row('', '', [findIn, findBtn, logShow]);

    const shotImg = el('img', { class: 'debug-shot', alt: '' });
    shotImg.hidden = true;
    const shotShow = UI.button(I18n.t('Show file'), () => shotShow.path && api.debugShow(shotShow.path), 'small');
    shotShow.hidden = true;
    const shotBtn = UI.button(I18n.t('Take'), async () => {
      shotBtn.disabled = true;
      shotRow.setHint(I18n.t('Taking…'));
      const r = await api.debugAsk(picked, 'shot', {});
      shotBtn.disabled = false;
      if (!r.ok) { shotRow.setHint(errText(r.error)); return; }
      shotImg.src = r.png;
      shotImg.hidden = false;
      shotShow.path = r.path;
      shotShow.hidden = false;
      shotRow.setHint(r.data && r.data.width ? `${r.data.width} × ${r.data.height}${r.data.displays > 1 ? ', ' + I18n.t('display {n} of {count}', { n: r.data.display + 1, count: r.data.displays }) : ''}` : '');
    }, 'small');
    const shotRow = UI.row(I18n.t('Screenshot'), '', [shotBtn, shotShow]);

    const diagSel = UI.select([], () => drawDiagPeer());
    const diagPeer = UI.select([], () => {});
    const diagHours = UI.select([1, 3, 12, 24, 48].map((h) => ({ value: h, label: I18n.t('{count} h', { count: h }) })), () => {});
    diagHours.set(3);
    const diagBox = pre();
    const diagBtn = UI.button(I18n.t('Run'), async () => {
      diagBtn.disabled = true;
      say(diagBox, I18n.t('Running…'));
      const r = await api.debugAsk(picked, 'diag', { name: diagSel.el.value, peer: diagPeer.el.value, hours: Number(diagHours.el.value) });
      diagBtn.disabled = false;
      say(diagBox, r.ok ? r.data.out || I18n.t('(nothing)') : errText(r.error));
    }, 'small');
    const diagRow = UI.row(I18n.t('Diagnostics'), '', [diagSel, diagPeer, diagHours, diagBtn]);
    function drawDiagPeer() {
      const h = hellos.get(picked);
      const list = picked === me ? (last && last.debug && last.debug.diags) || [] : (h && h.data && h.data.diags) || [];
      const d = list.find((x) => x.name === diagSel.el.value);
      diagPeer.el.hidden = !(d && d.peer);
      diagHours.el.hidden = diagSel.el.value !== 'events';
    }

    const cmdIn = el('input', { type: 'text', placeholder: I18n.t('A command, run there as that person'), class: 'debug-cmd', spellcheck: false });
    const cmdBox = pre();
    const cmdBtn = UI.button(I18n.t('Run'), async () => {
      const cmd = cmdIn.value.trim();
      if (!cmd) return;
      cmdBtn.disabled = true;
      say(cmdBox, I18n.t('Running…'));
      const r = await api.debugAsk(picked, 'run', { cmd, timeout: 60 });
      cmdBtn.disabled = false;
      say(cmdBox, r.ok ? `$ ${cmd}\n${r.data.out}${r.data.code ? `\n(exit ${r.data.code})` : ''}` : errText(r.error));
    }, 'small');
    cmdIn.onkeydown = (e) => { if (e.key === 'Enter') cmdBtn.onclick(); };
    const cmdRow = UI.row(I18n.t('Command'), '', [cmdIn, cmdBtn]);

    // Restart: a second click within 5 s does it (no dialog: a dialog would stop the window).
    const restartBtn = (what, label) => {
      const b = UI.button(label, async () => {
        if (!b.armed) {
          b.armed = true;
          b.textContent = I18n.t('Click again to restart');
          setTimeout(() => { b.armed = false; b.textContent = label; }, 5000);
          return;
        }
        b.armed = false;
        b.textContent = label;
        const r = await api.debugAsk(picked, 'restart', { what });
        restartRow.setHint(r.ok ? I18n.t('Restarting…') : errText(r.error));
      }, 'small');
      return b;
    };
    const restartApp = restartBtn('app', I18n.t('Restart TwinDesk'));
    const restartRow = UI.row(I18n.t('Restart'), '', [restartApp]);

    const pickCard = UI.card('', [statusRow, statusBox, pvRow, logRow, findRow, logBox, shotRow, shotImg, diagRow, diagBox, cmdRow, cmdBox, restartRow]);
    pickCard.prepend(el('div', { class: 'card-title' }, [pickTitle]));
    pickCard.hidden = true;

    function pick(id) {
      picked = id;
      for (const b of [statusBox, logBox, diagBox, cmdBox]) say(b, '');
      shotImg.hidden = true;
      shotShow.hidden = true;
      logShow.hidden = true;
      if (last) drawDevices(last);
      drawPicked();
      if (id) refreshStatus();
      schedule();
    }

    async function drawPicked() {
      pickCard.hidden = !picked;
      if (!picked) return;
      pickTitle.textContent = nameOf(picked);
      const h = picked === me ? { ok: true, data: { anyCommand: true, diags: (last && last.debug && last.debug.diags) || [] } } : hellos.get(picked);
      const tags = ['all', ...((last && last.debug && last.debug.tags) || [])];
      pvTag.options(tags.map((t) => ({ value: t, label: t === 'all' ? I18n.t('Everything') : t })));
      const diags = (h && h.data && h.data.diags) || [];
      diagSel.options(diags.map((d) => ({ value: d.name, label: d.label })));
      diagPeer.options(peersOf(last || {}).filter((p) => p.id !== picked).map((p) => ({ value: p.id, label: p.name })));
      drawDiagPeer();
      cmdRow.hidden = !(h && h.data && h.data.anyCommand);
      cmdBox.hidden = cmdRow.hidden || !cmdBox.textContent;
      if (!logFile.el.dataset.for || logFile.el.dataset.for !== picked) {
        logFile.el.dataset.for = picked;
        const r = await api.debugAsk(picked, 'files', {});
        if (r.ok) logFile.options(r.data.map((f) => ({ value: f.name, label: `${f.name === 'service' ? I18n.t('Full KVM service') : f.name === 'service-node' ? I18n.t('Full KVM machine node') : f.name} (${UI.bytes(f.size)})` })));
        else logFile.options([{ value: 'TwinDesk.log', label: 'TwinDesk.log' }]);
      }
    }

    // The status, as lines: what tells at a glance why a link or a crossing failed.
    function statusText(st) {
      const L = [];
      const ms = (v) => (v == null ? '–' : v < 1000 ? `${v} ms` : v < 60000 ? `${(v / 1000).toFixed(1)} s` : v < 7200000 ? `${Math.round(v / 60000)} min` : `${Math.round(v / 3600000)} h`);
      const dev = st.device || {};
      L.push(`${dev.name || ''}  TwinDesk ${dev.version || ''}  up ${Math.round((st.process || {}).uptime / 60)} min  (${st.at})`);
      const sys = (st.process || {}).system || {};
      L.push(`system: ${sys.platform} ${sys.release}, up ${Math.round((sys.uptime || 0) / 3600)} h, load ${(sys.loadavg || []).map((x) => x.toFixed(2)).join(' ')}`);
      const q = st.quiet || {};
      L.push(`quiet links: keep ${q.keep ? 'on' : 'off'}, holds [${(q.holds || []).join(', ')}], last wake ${q.wokeAgo == null ? 'never' : ms(q.wokeAgo) + ' ago'}`);
      if (st.verbose && st.verbose.tags && st.verbose.tags.length) L.push(`verbose: ${st.verbose.tags.join(', ')}`);
      const k = st.kvm;
      if (k) L.push(`kvm: ${k.mode}${k.partner ? ' with ' + k.partner : ''}${k.paused ? ', paused' : ''}${k.onBle ? ', through Bluetooth' : ''}`);
      if (st.fullkvm) L.push(`full kvm: ${JSON.stringify(st.fullkvm)}`);
      L.push('', 'sessions:');
      for (const s of st.sessions || []) {
        const sk = s.socket || {};
        L.push(`  ${s.name || s.id.slice(0, 8)}  ${s.state}${s.connected ? '' : ' (down)'}  ${s.role}  ${s.transport}  rtt ${ms(s.rtt)}  heard ${ms(s.rxAgo)} ago  sent ${ms(s.txAgo)} ago  queued ${s.queued}${s.busy ? '  busy' : ''}`);
        if (sk.address) L.push(`      socket ${sk.address} ${sk.open ? 'open' : 'closed'}, ping ${ms(sk.pingAgo)} ago${sk.quiet ? `, quiet ${ms(sk.quiet.since)}${sk.quiet.probe ? ' (probing)' : ''}` : ''}`);
        if (s.alt) L.push(`      also ${s.alt.transport} ${s.alt.address || ''}, heard ${ms(s.alt.rxAgo)} ago`);
        if (s.lane) L.push(`      input lane ${s.lane.started ? (s.lane.up ? 'up' : 'DOWN') : 'not started'}${s.lane.rtt != null ? ', ' + s.lane.rtt + ' ms' : ''}`);
        if (s.ignoredTypes) L.push(`      ignores: ${s.ignoredTypes.join(', ')}`);
      }
      const via = (st.peers || []).filter((p) => p.state === 'via');
      if (via.length) L.push('', 'through others:', ...via.map((p) => `  ${p.name} via ${(p.via || []).join(', ')}`));
      if (st.graph && Object.keys(st.graph).length) L.push('', 'graph:', ...Object.values(st.graph).map((x) => `  ${x}`));
      return L.join('\n');
    }

    async function refreshStatus() {
      if (!picked || !onScreen()) return;
      const r = await api.debugAsk(picked, 'status', {});
      if (!picked) return;
      say(statusBox, r.ok ? statusText(r.data) : errText(r.error));
      statusRow.setHint(r.ok ? I18n.t('As of {time}', { time: new Date().toLocaleTimeString(I18n.locale) }) : '');
    }

    // Only while this page is on screen and a device is picked.
    function schedule() {
      clearInterval(statusTimer);
      statusTimer = null;
      if (!picked || !statusSw.el.checked) return;
      const h = hellos.get(picked);
      const every = h && h.data && h.data.transport === 'ble' ? BLE_STATUS_MS : STATUS_MS;
      statusTimer = setInterval(refreshStatus, every);
    }

    // ---- Activity ----
    const actBox = el('div', { class: 'debug-activity' });
    const actCard = UI.card(I18n.t('Activity'), [actBox]);
    function drawActivity(s) {
      const list = (s.debug && s.debug.activity) || [];
      const key = JSON.stringify(list.map((e) => [e.at, e.ok]));
      if (actBox.dataset.key === key) return;
      actBox.dataset.key = key;
      actBox.replaceChildren(...(list.length ? list.map((e) => UI.row(
        `${new Date(e.at).toLocaleTimeString(I18n.locale)}  ${e.dir === 'in' ? e.name + ' → ' + I18n.t('here') : I18n.t('here') + ' → ' + e.name}  ${e.op}`,
        e.ok ? '' : errText(e.error),
        [el('span', { class: `pill ${e.ok ? 'good' : 'bad'}`, text: e.ok ? 'ok' : I18n.t('refused') })],
        { literal: true },
      )) : [UI.note('info', I18n.t('Nothing asked yet'))]));
    }

    body.append(thisCard, devCard, pickCard, actCard);

    // Every HELLO_MS while on screen; at once when the page comes up.
    helloTimer = setInterval(helloAll, HELLO_MS);
    new MutationObserver(() => { if (onScreen()) { helloAll(); if (picked) refreshStatus(); } }).observe(page, { attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('visibilitychange', () => { if (onScreen()) helloAll(); });

    return (s) => {
      const first = !last;
      last = s;
      me = s.device ? s.device.id : s.macId || '';
      drawThis(s);
      drawDevices(s);
      drawActivity(s);
      if (first && onScreen()) helloAll();
    };
  },
});
