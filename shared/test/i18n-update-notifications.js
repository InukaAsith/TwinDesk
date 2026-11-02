// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE. Release data is local; no network or installed app is used.
'use strict';
const assert = require('assert');
const { Updates } = require('../updates');
const current = '2.3.0', latest = '2.4.0-rc.1'; // real versions (#117: a tag that isn't one is ignored); the notes stay literal below
const notes = 'Remote release notes {version} $& <raw> stay literal.';

async function run() {
  for (const language of ['zh-CN', 'en', undefined]) for (const manual of [true, false]) {
    const settings = { updates: { auto: true, notified: '', skipped: '' } };
    const notifications = [], requests = [];
    let saves = 0, shown = 0, opened = 0;
    const owner = new Updates({
      current, platform: language === undefined ? 'linux' : 'win', arch: 'x64',
      getSettings: () => settings, save: () => { saves++; },
      notify: (...args) => notifications.push(args), onShowModal: () => { shown++; },
      openUrl: () => { opened++; },
      ...(language ? { getLanguage: () => language } : {}),
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ tag_name: 'v' + latest, body: notes, assets: [], html_url: 'https://example.invalid/release' }) };
      },
    });
    await owner.check(manual);
    assert.equal(notifications.length, 1, 'new version produces one notification');
    const [title, body, onClick] = notifications[0];
    assert.equal(title, language === 'zh-CN' ? `TwinDesk ${latest} 可用` : `TwinDesk ${latest} is available`, 'notification title uses local language and literal release version');
    const expected = language === 'zh-CN'
      ? manual ? '点击查看更新详情。' : `当前版本为 ${current}。点击查看更新详情和发行说明。`
      : manual ? 'Click to view update details.' : `You have ${current}. Click to view update details and release notes.`;
    assert.equal(body, expected, 'manual/automatic notification keeps literal current version');
    assert.equal(typeof onClick, 'function');
    onClick();
    assert.equal(shown, 1, 'click opens the same update modal');
    owner.onShowModal = () => { shown += 10; };
    onClick();
    assert.equal(shown, 11, 'notification retains its original owner callback behavior');
    assert.equal(opened, 0, 'translation does not open a URL');
    assert.equal(saves, 1);
    assert.equal(settings.updates.notified, latest);
    assert.equal(owner.status.available, true);
    assert.equal(owner.status.promptUpdate, true);
    assert.equal(owner.status.latest, latest);
    assert.equal(owner.status.releaseNotes, notes, 'remote release notes are never translated');
    assert.match(requests[0].url, /^https:\/\/api\.github\.com\/repos\/InukaAsith\/TwinDesk\/releases\/latest\?_=/);
    assert.equal(requests[0].options.headers['User-Agent'], `TwinDesk/${current}`);
    assert.equal(requests[0].options.cache, 'no-store');
    await owner.check(manual);
    assert.equal(notifications.length, 1, 'already notified version stays suppressed');
    assert.equal(saves, 1, 'notification bookkeeping is unchanged');
  }
  // Resolve the callback at notification time, rather than caching the startup language.
  let language = 'en';
  const notifications = [], settings = { updates: { auto: true, notified: '', skipped: '' } };
  const owner = new Updates({
    current: '2.3.0', platform: 'mac', getLanguage: () => language, getSettings: () => settings,
    notify: (...args) => notifications.push(args),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v2.4.0', assets: [] }) }),
  });
  language = 'zh-CN';
  await owner.check(true);
  assert.equal(notifications[0][0], 'TwinDesk 2.4.0 可用', 'language changes before a check affect the new notification');
  console.log('i18n-update-notifications: manual/auto EN/ZH, default Linux English, literal versions/notes, current language and unchanged click/check behavior passed');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
