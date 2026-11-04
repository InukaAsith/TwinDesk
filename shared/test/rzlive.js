// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume's live documents (shared/rzlive.js): only the shared file and what the app makes next to
// it while saving can be listed, read or written; a Word-style save lands on the original.
// Run with: node shared/test/rzlive.js (needs openssl for a test certificate; skipped without it)
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { LiveShare, volumeOf } = require('../rzlive.js');

const SP = fs.mkdtempSync(path.join(os.tmpdir(), 'rzlive-'));
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(SP, 'k.pem'), '-out', path.join(SP, 'c.pem'), '-days', '2', '-subj', '/CN=t'], { stdio: 'ignore' });
} catch (_) {
  console.log('rzlive: skipped (no openssl)');
  process.exit(0);
}
assert.strictEqual(volumeOf('/x/Q3: plan*.docx'), 'Q3 plan (ReZume)');
const dir = path.join(SP, 'docs');
fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, 'Report.docx'), 'v1');
fs.writeFileSync(path.join(dir, 'secret.txt'), 'no');
const opts = { key: fs.readFileSync(path.join(SP, 'k.pem')), cert: fs.readFileSync(path.join(SP, 'c.pem')) };

(async () => {
 const ls=new LiveShare({tls:()=>opts});
 const info=await ls.share(path.join(dir,'Report.docx'));
 const req=(method,p,body,headers={})=>new Promise((res,rej)=>{const r=https.request({host:'127.0.0.1',port:info.port,method,path:p,headers,ca:opts.cert,checkServerIdentity:()=>undefined},(x)=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>res({code:x.statusCode,d}))});r.on('error',rej);r.end(body)});
 const base='/'+info.token+'/'+encodeURIComponent(info.volume);
 let r=await req('PROPFIND',base+'/',null,{depth:'1'}); assert.strictEqual(r.code,207); assert(r.d.includes('Report.docx')); assert(!r.d.includes('secret'));
 assert.strictEqual((await req('GET',base+'/secret.txt')).code,404);
 assert.strictEqual((await req('PUT',base+'/secret.txt','x')).code,403);
 assert.strictEqual((await req('GET','/'+'0'.repeat(32)+'/x/Report.docx')).code,404);
 assert.strictEqual((await req('PROPFIND','/'+info.token+'/',null,{depth:'0'})).code,207);
 // Word-like save
 assert.strictEqual((await req('PUT',base+'/~$Report.docx','lock')).code,201);
 assert.strictEqual((await req('PUT',base+'/~WRD0001.tmp','v2')).code,201);
 assert.strictEqual((await req('MOVE',base+'/Report.docx',null,{destination:base+'/~WRL0002.tmp'})).code,201);
 assert.strictEqual((await req('MOVE',base+'/~WRD0001.tmp',null,{destination:base+'/Report.docx'})).code,201);
 assert.strictEqual((await req('DELETE',base+'/~WRL0002.tmp')).code,204);
 assert.strictEqual((await req('DELETE',base+'/~$Report.docx')).code,204);
 assert.strictEqual(fs.readFileSync(path.join(dir,'Report.docx'),'utf8'),'v2');
 assert.deepStrictEqual(fs.readdirSync(dir).sort(),['Report.docx','secret.txt']);
 assert.strictEqual((await req('MOVE',base+'/Report.docx',null,{destination:base+'/secret.txt'})).code,403);
 r=await req('GET',base+'/Report.docx',null,{range:'bytes=1-'}); assert.strictEqual(r.code,206); assert.strictEqual(r.d,'2');
 assert.strictEqual((await req('PUT',base+'/.DS_Store','x')).code,201); assert(!fs.existsSync(path.join(dir,'.DS_Store')));
 ls.stop();
 fs.rmSync(SP, { recursive: true, force: true });
 console.log('rzlive ok');
})().catch(e=>{console.error(e);process.exit(1)});
