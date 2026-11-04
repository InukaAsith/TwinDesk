// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume's file finding (shared/docfind.js): browsers' file: addresses, titles with Store apps'
// marks, VLC's list, the next file of a folder.
// Run with: node shared/test/docfind.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const d = require('../docfind.js');

// Browsers showing a local file.
assert.strictEqual(d.fileUrlPath('file:///C:/Users/me/My%20Docs/a.pdf', 'win32'), 'C:\\Users\\me\\My Docs\\a.pdf');
assert.strictEqual(d.fileUrlPath('file:///C:/Users/me/My Docs/a.pdf', 'win32'), 'C:\\Users\\me\\My Docs\\a.pdf'); // Chrome shows spaces as they are
assert.strictEqual(d.fileUrlPath('C:/Users/me/a.pdf', 'win32'), 'C:\\Users\\me\\a.pdf'); // Edge, unedited
assert.strictEqual(d.fileUrlPath('file://server/share/a.pdf', 'win32'), '\\\\server\\share\\a.pdf');
assert.strictEqual(d.fileUrlPath('file:///Users/me/R%C3%A9sum%C3%A9.pdf', 'darwin'), '/Users/me/Résumé.pdf');
assert.strictEqual(d.fileUrlPath('file:///home/me/a.pdf', 'linux'), '/home/me/a.pdf');
assert.strictEqual(d.fileUrlPath('https://example.com/a.pdf', 'linux'), '');
assert.strictEqual(d.fileUrlPath('C:/x.pdf', 'linux'), '');
assert.strictEqual(d.fileUrlPath('', 'win32'), '');

// Titles.
assert.strictEqual(d.clean('\u200eIMG_0042.jpg\u200e - Photos'), 'IMG_0042.jpg - Photos');
assert.deepStrictEqual(d.titleNames('\u200eIMG_0042.jpg\u200e - Photos'), ['IMG_0042.jpg']);
assert.deepStrictEqual(d.titleNames('movie.2024.1080p.mkv - PotPlayer'), ['movie.2024.1080p.mkv']);
assert.deepStrictEqual(d.titleNames('PotPlayer - clip.mp4'), ['clip.mp4']);
assert.deepStrictEqual(d.titleNames('*notes.txt - Mousepad'), ['notes.txt']);
assert.deepStrictEqual(d.titleNames('google.com - Google Chrome'), []);
assert.deepStrictEqual(d.titleNames('VLC media player'), []);
assert.ok(d.MEDIA.test('a.PDF') && d.MEDIA.test('b.mkv') && d.MEDIA.test('c.heic') && !d.MEDIA.test('index.js'));

// VLC's list: quoted entries (a comma in the name), file: URLs, newest first.
const ini = '[General]\nx=1\n\n[RecentsMRL]\nlist=file:///C:/Films/a%20b.mkv, "file:///C:/Films/c,d.mp4", https://example.com/s.m3u8\ntimes=0, 0, 0\n\n[MainWindow]\ny=2\n';
assert.deepStrictEqual(d.parseVlcIni(ini, 'win32'), ['C:\\Films\\a b.mkv', 'C:\\Films\\c,d.mp4']);
assert.deepStrictEqual(d.parseVlcIni('[RecentsMRL]\nlist=file:///home/me/v.webm', 'linux'), ['/home/me/v.webm']);
assert.deepStrictEqual(d.parseVlcIni('[Other]\nlist=file:///x.mp4', 'linux'), []);
assert.ok(d.isVlc('C:\\Program Files\\VideoLAN\\VLC\\vlc.exe') && d.isVlc('vlc') && !d.isVlc('C:\\x\\PotPlayerMini64.exe'));

// Files on disk: by name, then the next one of a folder.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docfind-'));
const a = path.join(dir, 'IMG_0001.jpg');
const b = path.join(dir, 'IMG_0002.jpg');
const r = path.join(dir, 'report.pdf');
for (const f of [a, b, r]) fs.writeFileSync(f, 'x');
assert.strictEqual(d.nameMatch('IMG_0001.jpg - Photos', [r, a]), a);
assert.strictEqual(d.nameMatch('report - Adobe Acrobat', [a, r]), r); // without its extension
assert.strictEqual(d.nameMatch('IMG_0002.jpg - Photos', [a, r]), null); // not on the list
assert.strictEqual(d.inFolders('\u200eIMG_0002.jpg - Photos', [dir]), b); // Photos went on to the next picture
assert.strictEqual(d.inFolders('img_0002.JPG - Photos', [dir]), b);
assert.strictEqual(d.inFolders('IMG_0003.jpg - Photos', [dir]), null);
assert.strictEqual(d.inFolders('Photos', [dir]), null);
assert.strictEqual(d.nameMatch('gone.pdf - Viewer', [path.join(dir, 'gone.pdf')]), null);
fs.rmSync(dir, { recursive: true, force: true });

console.log('docfind: ok');
