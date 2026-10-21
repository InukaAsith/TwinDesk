// A popup over the window while the pairing banner waits for an answer here: what the banner says,
// with its primary button (Allow / Codes match), which only presses the banner's own. Allow or
// Later closes the popup; the request stays in the banner (Deny / Cancel there), as before.
// PairPop.attach(banner, primary): it follows the banner by itself (MutationObserver).
(function () {
  function attach(banner, primary) {
    const body = document.createElement('div');
    body.className = 'pop-body';
    const ok = document.createElement('button');
    ok.className = 'btn primary';
    const later = document.createElement('button');
    later.className = 'btn';
    later.textContent = 'Later';
    const actions = document.createElement('div');
    actions.className = 'banner-actions';
    actions.append(later, ok);
    const pop = document.createElement('div');
    pop.className = 'pair-pop';
    pop.hidden = true;
    pop.setAttribute('role', 'dialog');
    pop.append(body, actions);
    document.body.append(pop);

    let closed = ''; // the request the popup was closed for: back only for another one
    const key = () => ['pair-title', 'pair-code'].map((id) => (document.getElementById(id) || {}).textContent).join('|'); // who, and the code
    const wanted = () => !banner.hidden && !primary.hidden && !primary.disabled;
    function sync() {
      if (!wanted()) {
        if (banner.hidden) closed = '';
        pop.hidden = true;
        return;
      }
      if (closed && closed === key()) return void (pop.hidden = true);
      closed = '';
      const text = banner.querySelector('.banner-text').cloneNode(true);
      for (const e of text.querySelectorAll('[id]')) e.removeAttribute('id');
      body.replaceChildren(...text.childNodes);
      ok.textContent = primary.textContent;
      pop.hidden = false;
    }
    function close() {
      closed = key();
      pop.hidden = true;
    }
    ok.onclick = () => {
      close();
      primary.click();
    };
    later.onclick = close;
    document.addEventListener('keydown', (e) => e.key === 'Escape' && !pop.hidden && close());
    new MutationObserver(sync).observe(banner, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'disabled'] });
    sync();
  }
  window.PairPop = { attach };
})();
