'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture(cancelSupported=true){
 const frames=new Map(),rafs=new Map();let next=0,uploads=0,presents=0;
 const video={requestVideoFrameCallback:fn=>{const id=next++;frames.set(id,fn);return id;}};
 if(cancelSupported)video.cancelVideoFrameCallback=id=>frames.delete(id);
 const context=vm.createContext({self:{},requestAnimationFrame:fn=>{const id=next++;rafs.set(id,fn);return id;},cancelAnimationFrame:id=>rafs.delete(id)});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../framegen.js'),'utf8'),context);
 const fg=new context.self.FrameGen(video,{});fg._init=()=>{fg.gl={};};fg._upload=()=>uploads++;fg._present=()=>presents++;
 return {fg,frames,rafs,get uploads(){return uploads;},get presents(){return presents;},frame(){const pending=[...frames.values()];frames.clear();for(const fn of pending)fn(1,{expectedDisplayTime:1});},refresh(){const pending=[...rafs.values()];rafs.clear();for(const fn of pending)fn(1);}};
}
test('repeated frame-generation toggles retain one video callback per decoded frame',()=>{
 const f=fixture();for(let i=0;i<20;i++){f.fg.start();f.fg.stop();}f.fg.start();f.frame();
 assert.equal(f.uploads,1);assert.equal(f.frames.size,1);f.fg.stop();
});
test('generation guard prevents duplicate work without video cancellation support',()=>{
 const f=fixture(false);for(let i=0;i<20;i++){f.fg.start();f.fg.stop();}f.fg.start();f.frame();
 assert.equal(f.uploads,1);assert.equal(f.frames.size,1);f.fg.stop();
});
test('stop cancels the pending video callback including callback ID zero',()=>{
 const f=fixture();f.fg.start();assert.equal(f.frames.size,1);f.fg.stop();assert.equal(f.frames.size,0);assert.equal(f.rafs.size,0);
});
test('callbacks already queued before restart cannot upload or create extra loops',()=>{
 const f=fixture();f.fg.start();const oldFrame=[...f.frames.values()][0],oldRefresh=[...f.rafs.values()][0];
 f.fg.stop();f.fg.start();oldFrame(2,{});oldRefresh(2);
 assert.equal(f.uploads,0);assert.equal(f.presents,0);assert.equal(f.frames.size,1);assert.equal(f.rafs.size,1);f.fg.stop();
});
test('calling start twice does not duplicate an active generation',()=>{
 const f=fixture();f.fg.start();f.fg.start();f.frame();f.refresh();
 assert.equal(f.uploads,1);assert.equal(f.presents,1);assert.equal(f.frames.size,1);assert.equal(f.rafs.size,1);f.fg.stop();
});
