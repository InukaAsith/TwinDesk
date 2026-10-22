// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Portions adapted from Beamer (https://github.com/kalkman-code/beamer), Copyright (C) Kalkman Code,
// GPL-3.0. Changed: JS port of win_app/firewall_win.py (status script + interpret), simplified to
// one program rule and no ports.
// Firewall self-check: the network must be Private, an enabled inbound allow rule for
// this electron.exe must cover it, and no block rule may apply. Fix adds the rule (and makes the
// LAN Private) with one elevated PowerShell (one UAC prompt).
const { script, scriptElevated } = require('./ps');

// scripts/firewall-status.ps1: the rules for this exe, the networks, whether this account is an admin.

const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const profilesOf = (s) => (/any/i.test(s) || !s ? null : String(s).split(/,\s*/));
const touches = (set, wanted) => set === null || wanted.some((w) => set.includes(w));

// Same reading as Beamer's interpret(): a block rule on a connected profile wins over allows.
function interpret(payload) {
  const rules = arr(payload.rules).filter((r) => /true/i.test(r.enabled) && /^(any|udp)$/i.test(r.protocol || 'Any'));
  const nets = arr(payload.networks);
  // The LAN is the internet-connected interface(s); else every connected one.
  const lan = nets.some((n) => /internet/i.test(n.ipv4)) ? nets.filter((n) => /internet/i.test(n.ipv4)) : nets;
  const lanProfiles = [...new Set(lan.map((n) => n.category).filter(Boolean))];
  const active = [...new Set(nets.map((n) => n.category).filter(Boolean))];
  const allows = rules.filter((r) => /allow/i.test(r.action)).map((r) => profilesOf(r.profile));
  const blocks = rules.filter((r) => /block/i.test(r.action)).map((r) => profilesOf(r.profile));
  const blocked = blocks.some((p) => touches(p, active.length ? active : ['Domain', 'Private', 'Public']));
  // Rules a standard account can't read (some managed PCs): the installer added them, so trust it
  // rather than ask for a Fix that account can't do.
  const unread = payload.readable === false;
  const covered = unread || (allows.length > 0 && lanProfiles.every((name) => allows.some((p) => touches(p, [name]))));
  // A Public network only matters when no allow rule covers Public (the installer's rule does).
  const publicNets = lan.filter((n) => n.category === 'Public' && !unread && !allows.some((p) => touches(p, ['Public']))).map((n) => ({ index: n.index, alias: n.alias }));
  let message = 'OK';
  if (!lan.length) message = 'No network connection.';
  else if (publicNets.length) message = 'The network "' + publicNets[0].alias + '" is Public, so Windows blocks {name}’s broadcasts.';
  else if (blocked) message = 'A Windows Firewall rule blocks TwinDesk Mesh.';
  else if (!covered) message = 'TwinDesk Mesh isn’t allowed through Windows Firewall on this network.';
  return { ok: lan.length > 0 && !publicNets.length && !blocked && covered, message, publicNets, blocked, covered, admin: payload.admin !== false, unread };
}

async function check(exe = process.execPath) {
  try {
    return { ...interpret(JSON.parse(await script('firewall-status', { Exe: exe }) || '{}')), checkedAt: Date.now() };
  } catch (e) {
    return { ok: false, message: 'Couldn’t check the firewall: ' + e.message, error: true, checkedAt: Date.now() };
  }
}

// One elevated PowerShell: make Public LAN interfaces Private, remove our block rules, add the allow rule.
// The rules cover every profile, so a Public network works too (TwinDesk's link is TLS, pinned to
// the pair, and a new pairing needs Allow on both sides); networks are still made Private when we
// can, for the shared folder. Needs an administrator: a standard account's UAC prompt asks for an
// admin's password, and declining it (or not having one) says so.
async function fix(status, exe = process.execPath) {
  // scripts/firewall-fix.ps1; also our rules an older Fix added with the path's backslashes doubled.
  try {
    await scriptElevated('firewall-fix', { // throws if the UAC prompt is declined
      Exe: exe,
      PublicIndexes: ((status && status.publicNets) || []).map((n) => Number(n.index)).filter(Number.isInteger).join(','),
      Blocked: !!(status && status.blocked),
    });
  } catch (e) {
    if (status && status.admin === false) throw new Error('it needs an administrator’s password. Ask someone with one to click Fix, or to reinstall TwinDesk (the installer adds the rule)');
    throw e;
  }
  return check(exe);
}

module.exports = { check, fix, interpret };
