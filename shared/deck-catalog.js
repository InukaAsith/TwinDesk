// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck's actions as people choose them (the action picker on the computer's Deck page and on
// the phone): each entry's group, name, one line on what it does, the action it makes
// (shared/deck-model.js) and what this computer needs for it (deck.js caps, platform).
// entry(action) finds the entry an action came from, for its name on a tile and in the editor.
// CommonJS in tests, a plain <script> in renderers (window.DeckCatalog).
'use strict';

(function (root) {
  const GROUPS = [
    { id: 'keyboard', name: 'Keyboard' },
    { id: 'media', name: 'Media' },
    { id: 'sound', name: 'Sound' },
    { id: 'bluetooth', name: 'Bluetooth' },
    { id: 'display', name: 'Display' },
    { id: 'windows', name: 'Windows' },
    { id: 'system', name: 'System' },
    { id: 'open', name: 'Apps and websites' },
    { id: 'files', name: 'Files and scripts' },
    { id: 'clipboard', name: 'Clipboard' },
    { id: 'widgets', name: 'Widgets' },
    { id: 'deck', name: 'Deck navigation' },
  ];

  // needs: a caps key (deck.js) that must be true; only: platforms that have it.
  const e = (group, name, desc, action, o = {}) => ({ id: action.k + (action.what ? '.' + action.what : ''), group, name, desc, action, ...o });
  const OVERVIEW = { mac: 'Mission Control', win: 'Task view', linux: 'Activities overview' };
  const ENTRIES = [
    e('keyboard', 'Keyboard shortcut', 'Presses a key combination. Record it or type it.', { k: 'keys', combo: '' }),
    e('keyboard', 'Type text', 'Types a snippet as if from the keyboard, optionally followed by Return.', { k: 'text', text: '' }),
    e('keyboard', 'Multi-action', 'Runs several actions in order, with a pause before any of them.', { k: 'macro', steps: [] }),

    e('media', 'Play or pause', 'Toggles playback in the app that is playing.', { k: 'media', what: 'playpause' }),
    e('media', 'Next track', 'Skips to the next track.', { k: 'media', what: 'next' }),
    e('media', 'Previous track', 'Goes back to the previous track.', { k: 'media', what: 'prev' }),
    e('media', 'Stop', 'Stops playback.', { k: 'media', what: 'stop' }),

    e('sound', 'Volume slider', 'A slider for the output volume, live as you drag.', { k: 'slider', what: 'volume' }, { needs: 'audio', wide: true }),
    e('sound', 'Volume up', 'Raises the output volume by a set step.', { k: 'volume', what: 'up', step: 6 }, { needs: 'audio' }),
    e('sound', 'Volume down', 'Lowers the output volume by a set step.', { k: 'volume', what: 'down', step: 6 }, { needs: 'audio' }),
    e('sound', 'Set volume', 'Sets the output volume to an exact level.', { k: 'volume', what: 'set', level: 50 }, { needs: 'audio' }),
    e('sound', 'Mute or unmute', 'Toggles the output mute. The tile shows whether it is muted.', { k: 'volume', what: 'toggle' }, { needs: 'audio' }),
    e('sound', 'Mute', 'Mutes the output.', { k: 'volume', what: 'mute' }, { needs: 'audio' }),
    e('sound', 'Unmute', 'Unmutes the output.', { k: 'volume', what: 'unmute' }, { needs: 'audio' }),
    e('sound', 'Microphone mute', 'Toggles the default microphone. The tile shows whether it is live.', { k: 'mic', what: 'toggle' }, { needs: 'mic' }),
    e('sound', 'Mute microphone', 'Mutes the default microphone.', { k: 'mic', what: 'mute' }, { needs: 'mic' }),
    e('sound', 'Unmute microphone', 'Unmutes the default microphone.', { k: 'mic', what: 'unmute' }, { needs: 'mic' }),
    e('sound', 'Microphone level', 'A slider for the input level of the default microphone.', { k: 'slider', what: 'mic' }, { needs: 'mic', wide: true }),
    e('sound', 'Audio output', 'Makes a chosen speaker or headset the default output, or cycles through them.', { k: 'output', id: '', name: '' }, { needs: 'outputs' }),
    e('sound', 'Audio input', 'Makes a chosen microphone the default input.', { k: 'input', id: '', name: '' }, { needs: 'outputs' }),

    e('bluetooth', 'Connect or disconnect', 'Connects a paired device, or disconnects it if it is connected.', { k: 'bt', what: 'toggleconn', id: '', name: '' }, { needs: 'bt' }),
    e('bluetooth', 'Connect device', 'Connects a paired device, such as headphones or a speaker.', { k: 'bt', what: 'connect', id: '', name: '' }, { needs: 'bt' }),
    e('bluetooth', 'Disconnect device', 'Disconnects a paired device.', { k: 'bt', what: 'disconnect', id: '', name: '' }, { needs: 'bt' }),
    e('bluetooth', 'Bluetooth on or off', 'Toggles Bluetooth on this computer.', { k: 'bt', what: 'toggle' }, { needs: 'bt' }),

    e('display', 'Brightness slider', 'A slider for one display’s brightness, or all of them. External monitors work over DDC/CI.', { k: 'slider', what: 'bright', display: '' }, { needs: 'bright', wide: true }),
    e('display', 'Brightness up', 'Raises the brightness by 10%.', { k: 'bright', what: 'up', display: '' }, { needs: 'bright' }),
    e('display', 'Brightness down', 'Lowers the brightness by 10%.', { k: 'bright', what: 'down', display: '' }, { needs: 'bright' }),
    e('display', 'Set brightness', 'Sets the brightness to an exact level.', { k: 'bright', what: 'set', level: 70, display: '' }, { needs: 'bright' }),
    e('display', 'Turn displays off', 'Turns the screens off until the mouse or keyboard wakes them.', { k: 'sys', what: 'screenoff' }, { needs: 'screenoff' }),
    e('display', 'Dark mode', 'Switches between the light and dark appearance.', { k: 'sys', what: 'darkmode' }, { needs: 'darkmode' }),

    e('windows', 'Left half', 'Moves the front window to the left half of its display.', { k: 'win', what: 'left' }, { needs: 'win' }),
    e('windows', 'Right half', 'Moves the front window to the right half of its display.', { k: 'win', what: 'right' }, { needs: 'win' }),
    e('windows', 'Top half', 'Moves the front window to the top half of its display.', { k: 'win', what: 'top' }, { needs: 'windows' }),
    e('windows', 'Bottom half', 'Moves the front window to the bottom half of its display.', { k: 'win', what: 'bottom' }, { needs: 'windows' }),
    e('windows', 'Top-left quarter', 'Moves the front window to the top-left quarter.', { k: 'win', what: 'tl' }, { needs: 'windows' }),
    e('windows', 'Top-right quarter', 'Moves the front window to the top-right quarter.', { k: 'win', what: 'tr' }, { needs: 'windows' }),
    e('windows', 'Bottom-left quarter', 'Moves the front window to the bottom-left quarter.', { k: 'win', what: 'bl' }, { needs: 'windows' }),
    e('windows', 'Bottom-right quarter', 'Moves the front window to the bottom-right quarter.', { k: 'win', what: 'br' }, { needs: 'windows' }),
    e('windows', 'First third', 'Moves the front window to the left third.', { k: 'win', what: 'third1' }, { needs: 'windows' }),
    e('windows', 'Center third', 'Moves the front window to the center third.', { k: 'win', what: 'third2' }, { needs: 'windows' }),
    e('windows', 'Last third', 'Moves the front window to the right third.', { k: 'win', what: 'third3' }, { needs: 'windows' }),
    e('windows', 'Fill the display', 'Sizes the front window to fill its display, keeping the menu bar and taskbar.', { k: 'win', what: 'max' }, { needs: 'win' }),
    e('windows', 'Center', 'Centers the front window on its display.', { k: 'win', what: 'center' }, { needs: 'windows' }),
    e('windows', 'Full screen', 'Toggles full screen (maximize on Windows).', { k: 'win', what: 'full' }, { needs: 'windows' }),
    e('windows', 'Minimize', 'Minimizes the front window.', { k: 'win', what: 'min' }, { needs: 'win' }),
    e('windows', 'Next display', 'Moves the front window to the next display, keeping its place and size.', { k: 'win', what: 'nextdisplay' }, { needs: 'win' }),
    e('windows', 'Close window', 'Closes the front window.', { k: 'win', what: 'close' }, { needs: 'win' }),
    e('windows', 'Show desktop', 'Moves every window aside to show the desktop.', { k: 'sys', what: 'desktop' }),
    e('windows', OVERVIEW, 'Shows every open window.', { k: 'sys', what: 'overview' }),
    e('windows', 'Previous app', 'Switches to the app used last.', { k: 'sys', what: 'switcher' }),

    e('system', 'Lock screen', 'Locks this computer.', { k: 'sys', what: 'lock' }),
    e('system', 'Sleep', 'Puts this computer to sleep.', { k: 'sys', what: 'sleep' }),
    e('system', 'Screenshot', 'Takes a screenshot of the whole screen.', { k: 'sys', what: 'screenshot' }),
    e('system', 'Screenshot of a selection', 'Starts a screenshot of a part of the screen you select.', { k: 'sys', what: 'shotarea' }),
    e('system', 'Do Not Disturb', 'Toggles notification banners.', { k: 'sys', what: 'dnd' }, { needs: 'dnd' }),

    e('open', 'Open app', 'Opens an app on this computer, or brings it to the front.', { k: 'app', id: '', name: '' }),
    e('open', 'Open website', 'Opens a web address in the default browser.', { k: 'url', url: '' }),

    e('files', 'Open file or folder', 'Opens a file in its app, or a folder in the file manager.', { k: 'open', path: '' }, { local: true }),
    e('files', 'Run script', { mac: 'Runs a script file you saved, as a double-click in Finder would: save it as a .command file.', win: 'Runs a script file you saved (.bat or .cmd), as a double-click in File Explorer would.', linux: 'Runs a script file you saved, as a double-click in the file manager would. Make it executable first.' },
      { k: 'script', path: '' }, { local: true }),

    e('clipboard', 'Copy', 'Copies the selection.', { k: 'clip', what: 'copy' }),
    e('clipboard', 'Cut', 'Cuts the selection.', { k: 'clip', what: 'cut' }),
    e('clipboard', 'Paste', 'Pastes the clipboard.', { k: 'clip', what: 'paste' }),
    e('clipboard', 'Send clipboard to the phone', 'Sends what is copied on this computer to the device’s clipboard.', { k: 'clip', what: 'send' }),

    e('widgets', 'Clock', 'The time and date, on the device.', { k: 'widget', what: 'clock' }, { device: true, wide: true }),
    e('widgets', 'Media player', 'What is playing on this computer, with play, pause and skip.', { k: 'widget', what: 'media' }, { device: true, wide: true }),
    e('widgets', 'CPU', 'How busy this computer’s processor is, live.', { k: 'widget', what: 'cpu' }, { device: true, needs: 'perf' }),
    e('widgets', 'Memory', 'How much of this computer’s memory is in use, live.', { k: 'widget', what: 'ram' }, { device: true, needs: 'perf' }),
    e('widgets', 'Temperature', 'How hot this computer’s processor is, live.', { k: 'widget', what: 'temp' }, { device: true, needs: 'temp' }),

    e('deck', 'Go to page', 'Opens another page of this space.', { k: 'nav', what: 'page', to: '' }, { device: true }),
    e('deck', 'Go to space', 'Opens another space.', { k: 'nav', what: 'space', to: '' }, { device: true }),
    e('deck', 'Next page', 'Opens the next page.', { k: 'nav', what: 'next' }, { device: true }),
    e('deck', 'Previous page', 'Opens the previous page.', { k: 'nav', what: 'prev' }, { device: true }),
    e('deck', 'Next space', 'Opens the next space.', { k: 'nav', what: 'nextspace' }, { device: true }),
    e('deck', 'Previous space', 'Opens the previous space.', { k: 'nav', what: 'prevspace' }, { device: true }),
    e('deck', 'Label only', 'A tile that does nothing, for a heading or a gap.', { k: 'none' }, { device: true }),
  ];

  const text = (v, platform) => (v && typeof v === 'object' ? v[platform] || v.mac : v);
  // Where this computer can run it: {ok, why}.
  function available(x, caps, platform) {
    if (x.needs && caps && caps[x.needs] === false) {
      return { ok: false, why: platform === 'linux' && x.needs === 'screenoff' ? 'Not on Linux' : platform === 'linux' && x.needs === 'windows' ? 'Not on Wayland' : platform === 'mac' && x.needs === 'dnd' ? 'macOS has no switch for apps' : 'Not on this computer' };
    }
    return { ok: true };
  }
  function entry(a) {
    if (!a) return null;
    return ENTRIES.find((x) => x.action.k === a.k && (x.action.what === undefined || x.action.what === a.what)) || null;
  }
  const name = (a, platform) => { const x = entry(a); return x ? text(x.name, platform) : ''; };

  const api = { GROUPS, ENTRIES, available, entry, name, text };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeckCatalog = api;
})(typeof window !== 'undefined' ? window : globalThis);
