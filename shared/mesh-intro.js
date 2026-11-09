// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device (Mesh mode, beta) in the one-to-one app: the picture of a mesh on its tab, and the popup
// before it's turned on, which says it's in beta (docs/multi-device.md).
//   MeshIntro.art()                 -> an element: devices, each one linked to every other
//   MeshIntro.confirm(onTurnOn)     -> the popup (styled as pairpop.js's .pair-pop); Turn on calls onTurnOn
(function () {
  const t = (text) => window.I18n ? window.I18n.t(text) : text;
  // Each device: [kind, x, y]. Lines join every pair, as the mesh does.
  const NODES = [['monitor', 110, 78], ['laptop', 320, 46], ['monitor', 530, 84], ['phone', 214, 196], ['laptop', 430, 200]];

  const device = (kind, x, y) => FeatureArt.device(kind, x, y); // shared/feature-art.js, loaded first

  function art() {
    const lines = [];
    const dots = [];
    for (let i = 0; i < NODES.length; i++) {
      for (let j = i + 1; j < NODES.length; j++) {
        const [, x1, y1] = NODES[i];
        const [, x2, y2] = NODES[j];
        lines.push(`<line class="mi-link" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
        // A copy or a pointer on its way: a dot running along some of the links.
        if ((i + j) % 2) {
          const dur = 2.4 + ((i * 3 + j) % 4) * 0.5;
          dots.push(`<circle class="mi-dot" r="3.5"><animateMotion dur="${dur}s" repeatCount="indefinite" path="M${x1} ${y1}L${x2} ${y2}"/></circle>`);
        }
      }
    }
    const wrap = document.createElement('div');
    wrap.className = 'mesh-art';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML = `<svg viewBox="0 0 640 250" role="img">${lines.join('')}${dots.join('')}${NODES.map((n) => device(...n)).join('')}</svg>`
;
    const caption = document.createElement('p');
    caption.textContent = t('Every device linked to every other: one clipboard and one set of notifications for all, and the mouse and keyboard across all of them.');
    wrap.append(caption);
    return wrap;
  }

  // Said before it's turned on: it's in beta, and with two devices the one-to-one app is the one to use.
  function confirm(onTurnOn) {
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };

    const pop = el('div', 'pair-pop mesh-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    const body = el('div', 'pop-body');
    const title = el('strong', '', t("Turn on Multi-device? "));
    title.append(el('span', 'pill beta', t("Mesh · Beta")));
    body.append(
      title,
      el('p', '', t("Mesh mode is still in beta, and you may run into some issues with it.")),
      el('p', '', t("If you connect only two devices, keep it off.")),
      el('div', 'hint', t("TwinDesk restarts when you turn it on or off.")),
    );
    const cancel = el('button', 'btn', t("Cancel"));
    const ok = el('button', 'btn primary', t("Turn on"));
    const actions = el('div', 'banner-actions');
    actions.append(cancel, ok);
    pop.append(body, actions);

    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      pop.remove();
    };
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    cancel.onclick = close;
    ok.onclick = () => {
      close();
      onTurnOn();
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(pop);
    ok.focus();
  }

  // A yes/no pop like confirm's, for any switch that needs one: {title, lines, hint, ok}; onOk on yes,
  // onNo on Cancel or Escape (Cursor › Mouse and keyboard over Bluetooth).
  function ask({ title, lines = [], hint = '', ok }, onOk, onNo = () => {}) {
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    const pop = el('div', 'pair-pop mesh-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    const body = el('div', 'pop-body');
    body.append(el('strong', '', title), ...lines.map((l) => el('p', '', l)));
    if (hint) body.append(el('div', 'hint', hint));
    const no = el('button', 'btn', t('Cancel'));
    const yes = el('button', 'btn primary', ok);
    const actions = el('div', 'banner-actions');
    actions.append(no, yes);
    pop.append(body, actions);
    const close = () => { document.removeEventListener('keydown', onKey, true); pop.remove(); };
    function onKey(e) { if (e.key === 'Escape') { close(); onNo(); } }
    no.onclick = () => { close(); onNo(); };
    yes.onclick = () => { close(); onOk(); };
    document.addEventListener('keydown', onKey, true);
    document.body.append(pop);
    yes.focus();
  }

  window.MeshIntro = { art, confirm, ask };
})();
