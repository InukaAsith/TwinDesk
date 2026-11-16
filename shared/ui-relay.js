// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General › Your own relay (Mac, Windows, Linux): the address (and key) of a TwinDesk Relay you run
// (relay/twindesk-relay.js, shared/relay.js), so a phone away from this network can connect. Empty
// by default: nothing runs and nothing is sent anywhere until an address is saved.
//   const r = UI.relayCard(); page.append(r.el); on each state: r.update(state.net.relay)
'use strict';

(() => {
  const t = (...a) => I18n.t(...a);
  UI.relayCard = function relayCard() {
    const { el } = UI;
    const addr = el('input', { type: 'text', class: 'relay-addr', attrs: { placeholder: 'relay.example.com:47100', spellcheck: 'false', autocomplete: 'off', 'aria-label': t('Relay address') } });
    const key = el('input', { type: 'password', class: 'relay-key', attrs: { placeholder: t('Key (if it has one)'), autocomplete: 'off', 'aria-label': t('Relay key') } });
    const save = UI.button(t('Save'), () => UI.api.setNet({ relay: { addr: addr.value.trim(), key: key.value } }), 'small');
    const remove = UI.button(t('Remove'), () => { addr.value = ''; key.value = ''; UI.api.setNet({ relay: { addr: '', key: '' } }); }, 'small');
    const row = UI.row(t('Relay address'), '', [addr, key, save, remove]);
    const how = UI.row(t('How it works'), t('Run TwinDesk Relay (relay/twindesk-relay.js in TwinDesk’s source, Node only) on a server both devices can reach, and add its address here. A phone that isn’t on this network then connects through it. The relay only passes on the session, which stays encrypted end to end with this computer’s certificate: it can’t read anything or tell which devices they are.'), []);
    const card = UI.card(t('Your own relay'), [row, how]);
    let typed = false;
    addr.oninput = key.oninput = () => { typed = true; };
    return {
      el: card,
      update(r) {
        r = r || {};
        if (!typed || document.activeElement !== addr) { addr.value = r.addr || ''; if (!typed) key.value = r.key || ''; }
        remove.hidden = !r.addr;
        const why = r.error ? ` · ${t(r.error)}` : '';
        row.setHint(!r.addr ? t('None: the phone connects on this network, the cable, Bluetooth or Tailscale')
          : r.state === 'ready' ? t('Connected to the relay: a phone away from here can reach this computer')
            : r.state === 'connecting' ? t('Connecting to the relay…')
              : t('Can’t reach the relay{why}', { why }));
      },
    };
  };
})();
