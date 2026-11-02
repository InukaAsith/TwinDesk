'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const P = require('../../shared/protocol');
let root;
const load = Module._load;
Module._load = function(id, ...args) {
 if(id==='electron')return {app:{getPath:()=>root}};
 if(id==='child_process')return {spawn:()=>({unref(){}})};
 return load.call(this,id,...args);
};
const FileRecv = require('../filerecv');
const FileDrop = require('../filedrop');
Module._load=load;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture(t) {
 root=fs.mkdtempSync(path.join(os.tmpdir(),'twindesk-perf-')); const dir=root,sent=[];
 const link=Object.assign(new EventEmitter(),{send:m=>sent.push(m)});
 const recv=new FileRecv({link,settings:{files:{acceptFromMac:true}},helper:{request:async()=>({})},onChange(){}});
 const f={id:'id',name:'file.txt',tmp:path.join(dir,'source.part')};fs.writeFileSync(f.tmp,'hello');
 recv.files.set(f.id,f);recv.target=dir;
 t.after(()=>{link.emit('closed');fs.rmSync(dir,{recursive:true,force:true});});
 return {recv,f,dir,sent,link};
}
function copying(t) {
 const link=fs.promises.link,copy=fs.promises.copyFile;
 const entered=deferred(),finish=deferred();
 fs.promises.link=async()=>{throw Object.assign(new Error('different drive'),{code:'EXDEV'});};
 fs.promises.copyFile=async(...args)=>{await copy(...args);entered.resolve();await finish.promise;};
 t.after(()=>{fs.promises.link=link;fs.promises.copyFile=copy;});
 return {entered,finish};
}
test('cross-volume placement yields while copying and reports success only afterward',async t=>{
 const f=fixture(t),c=copying(t);const pending=f.recv._place(f.f);await c.entered.promise;
 assert.equal(f.sent.length,0);assert.equal(f.recv.files.size,1);
 let responsive=false;await new Promise(r=>setImmediate(()=>{responsive=true;r();}));assert.equal(responsive,true);
 c.finish.resolve();await pending;assert.equal(f.sent.at(-1).ok,true);assert.equal(fs.readFileSync(path.join(f.dir,'file.txt'),'utf8'),'hello');
});
test('canceling during asynchronous placement removes its newly created destination',async t=>{
 const f=fixture(t),c=copying(t);const pending=f.recv._place(f.f);await c.entered.promise;
 f.recv._drop('id');c.finish.resolve();await pending;
 assert.equal(fs.existsSync(path.join(f.dir,'file.txt')),false);assert.equal(f.sent.some(m=>m.ok),false);assert.equal(fs.existsSync(f.f.tmp),false);
});
test('a repeated release cannot start a second placement of the same file',async t=>{
 const f=fixture(t),c=copying(t);const pending=f.recv._place(f.f);await c.entered.promise;
 await f.recv._place(f.f);c.finish.resolve();await pending;
 assert.equal(f.sent.filter(m=>m.ok).length,1);assert.equal(fs.readdirSync(f.dir).filter(n=>n.endsWith('.txt')).length,1);
});
test('batch cancellation during copy does not acknowledge or retain the destination',async t=>{
 const f=fixture(t),c=copying(t);f.recv._drop('id');
 f.link.emit(P.T.FILE_OFFER,{id:'batch-file',name:'batch.txt',size:1,drop:'send',batch:'b',count:1});
 f.link.emit(P.T.FILE_CHUNK,{id:'batch-file',seq:0,data:Buffer.from('x')});
 f.link.emit(P.T.FILE_END,{id:'batch-file',sha256:crypto.createHash('sha256').update('x').digest('hex')});
 await c.entered.promise;f.link.emit(P.T.FILE_CANCEL,{id:'batch-file'});c.finish.resolve();
 for(let i=0;i<100&&fs.existsSync(path.join(f.dir,'batch.txt'));i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(fs.existsSync(path.join(f.dir,'batch.txt')),false);assert.equal(f.sent.some(m=>m.t===P.T.FILE_DONE&&m.ok),false);
});
test('copy fallback never overwrites a file created during transfer',async t=>{
 const f=fixture(t);const link=fs.promises.link;fs.promises.link=async()=>{throw Object.assign(new Error('different drive'),{code:'EXDEV'});};
 t.after(()=>{fs.promises.link=link;});
 const copy=fs.promises.copyFile;fs.promises.copyFile=async(source,dest,flags)=>{fs.writeFileSync(dest,'other app');return copy(source,dest,flags);};
 t.after(()=>{fs.promises.copyFile=copy;});await f.recv._place(f.f);
 assert.equal(f.sent.at(-1).ok,false);assert.equal(fs.readFileSync(path.join(f.dir,'file.txt'),'utf8'),'other app');
});
test('rapid chunk progress keeps exact counts while limiting expensive callbacks',()=>{
 const now=Date.now;let time=100000,calls=0,batchCalls=0;Date.now=()=>time;
 try {
  const drop=new FileDrop({link:new EventEmitter(),onProgress:()=>{calls++;},onBatchProgress:()=>{batchCalls++;}});
  const batch={sent:0};drop.batches.set('b',batch);const cur={sent:0};
  for(let i=0;i<10000;i++){time=100000+Math.floor(i/10);drop._sent({batch:'b'},cur,65536,true);}
  assert.equal(cur.sent,655360000);assert.equal(batch.sent,cur.sent);assert.ok(calls<=10);assert.equal(batchCalls,calls);
 }finally{Date.now=now;}
});
test('completion and cancellation progress bypass chunk-rate limiting',()=>{
 let calls=0;const drop=new FileDrop({link:Object.assign(new EventEmitter(),{send(){}}),onProgress:()=>{calls++;}});
 drop._sent({}, {sent:0},1,true);drop._report('file',true,'Saved');drop.cancel();assert.equal(calls,3);assert.equal(drop.last.ok,true);
});

test('simultaneous direct placements with the same name reserve separate destinations',async t=>{
 const f=fixture(t),second={id:'second',name:f.f.name,tmp:path.join(f.dir,'second.part')};
 fs.writeFileSync(second.tmp,'second');f.recv.files.set(second.id,second);
 await Promise.all([f.recv._place(f.f),f.recv._place(second)]);
 assert.equal(f.sent.filter(m=>m.ok).length,2);
 assert.deepEqual(fs.readdirSync(f.dir).filter(n=>n.endsWith('.txt')).map(n=>fs.readFileSync(path.join(f.dir,n),'utf8')).sort(),['hello','second']);
 assert.equal(f.recv.placements.size,0);
});
