import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createOverlayMonitor,clampPosition} from '../src/overlay.mjs';

function harness(){
  let status={running:false,showOverlay:true},view,reads=0,pending;
  const timers=new Set();
  const monitor=createOverlayMonitor({
    rpc:async message=>{assert.equal(message.type,'OVERLAY_STATUS');reads++;return pending?pending():structuredClone(status);},
    createView:()=>{assert.equal(view,undefined);view={render(s,c){this.status=s;this.config=c;},destroy(){view=undefined;}};return view;},
    schedule:fn=>{timers.add(fn);return fn;},cancel:fn=>timers.delete(fn),
  });
  return {monitor,timers,get view(){return view;},get reads(){return reads;},state:s=>{status={...status,...s};},pending:fn=>{pending=fn;}};
}

test('floating status requires both active control and opt-in, across start/stop and setting changes',async()=>{
  const x=harness();await x.monitor.refresh();assert.equal(x.view,undefined);assert.equal(x.timers.size,0);
  x.state({running:true,decisions:3});await x.monitor.changed(true);assert.equal(x.view.status.decisions,3);assert.equal(x.timers.size,1);
  await x.monitor.configure({showOverlay:false});assert.equal(x.view,undefined);assert.equal(x.timers.size,0);
  const before=x.reads;await x.monitor.changed(true);assert.equal(x.reads,before);assert.equal(x.view,undefined);
  await x.monitor.changed(false);x.state({running:false});await x.monitor.configure({showOverlay:true});assert.equal(x.view,undefined);
  x.state({running:true});await x.monitor.changed(true);assert.ok(x.view);
  x.monitor.changed(false);assert.equal(x.view,undefined);assert.equal(x.timers.size,0);
  x.monitor.dispose();
});

test('late status cannot resurrect the window after stop, opt-out, tab hiding or disposal',async()=>{
  for(const action of [x=>x.changed(false),x=>x.configure({showOverlay:false}),x=>x.setActive(false),x=>x.dispose()]){
    const x=harness();x.state({running:true});await x.monitor.refresh();assert.ok(x.view);
    let resolve;x.pending(()=>new Promise(r=>{resolve=r;}));const pending=x.monitor.refresh();
    action(x.monitor);assert.equal(x.view,undefined);
    resolve({running:true,showOverlay:true});await pending;assert.equal(x.view,undefined);assert.equal(x.timers.size,0);x.monitor.dispose();
  }
});

test('status polling stops when idle, hidden or disconnected; visibility restoration checks fresh state',async()=>{
  const x=harness();x.state({running:true});await x.monitor.refresh();assert.ok(x.view);
  await x.monitor.configure({language:'en'});assert.equal(x.view.config.language,'en');assert.equal(x.timers.size,1);
  await x.monitor.setActive(false);assert.equal(x.view,undefined);assert.equal(x.timers.size,0);
  x.state({running:false});await x.monitor.setActive(true);assert.equal(x.view,undefined);assert.equal(x.timers.size,0);
  x.state({running:true});await x.monitor.changed(true);assert.ok(x.view);
  x.pending(()=>Promise.reject(Error('Extension context invalidated')));await [...x.timers][0]();
  assert.equal(x.view,undefined);assert.equal(x.timers.size,0);x.monitor.dispose();
});

test('re-enabling display waits for current status instead of showing the previous session',async()=>{
  const x=harness();x.state({running:true});await x.monitor.refresh();await x.monitor.configure({showOverlay:false});
  let resolve;x.pending(()=>new Promise(r=>{resolve=r;}));const update=x.monitor.configure({showOverlay:true});assert.equal(x.view,undefined);
  resolve({running:false,showOverlay:true});await update;assert.equal(x.view,undefined);x.monitor.dispose();
});

test('drag placement remains inside normal and small viewports',()=>{
  assert.deepEqual(clampPosition({x:900,y:-30},282,150,800,600),{x:510,y:8});
  assert.deepEqual(clampPosition({x:400,y:500},282,150,240,100),{x:8,y:8});
});

// The view is created against a closed shadow root and a real DOM, so the DOM behaviour below is
// asserted on the source rather than by rendering it. Both regressions came from this file: a panel
// that rendered its records box blank, and one that reserved a third of its height for alerts that
// were not there. Reading the source is the only check available without a DOM harness.
test('the record box shows an empty state on first render instead of staying blank',()=>{
  const src=fs.readFileSync(new URL('../src/overlay.mjs',import.meta.url),'utf8');
  // The empty state hashes to '', so an initial key of '' compares equal and the first render skips
  // the branch -- the box stayed empty with no message until this was fixed.
  assert.match(src,/lastRecordKey\s*=\s*null/, 'the initial key must be distinguishable from the empty state');
  assert.match(src,/newest!==lastRecordKey\s*\|\|\s*lastRecordKey===null/,
    'the first render must run the branch even when there are no records yet');
  assert.match(src,/li\.className='empty';li\.textContent=tr\('overlayNoLog'\)/,
    'the empty state must still be rendered when there is nothing to show');
});

test('the records box is two fixed rows and the alert block reserves only what it shows',()=>{
  const src=fs.readFileSync(new URL('../src/overlay.mjs',import.meta.url),'utf8');
  assert.match(src,/const RECORD_ROWS = 2/, 'two rows, per the design');
  assert.match(src,/\.records\{[^}]*height:46px/, 'the box is pinned so the sections below never move');
  assert.match(src,/\.records\{[^}]*overflow:hidden/, 'a two-row box does not scroll');
  assert.match(src,/@keyframes rowIn/, 'a new record animates in');
  assert.match(src,/@media \(prefers-reduced-motion:reduce\)\{\.records li\{animation:none\}\}/,
    'reduced motion must switch the animation off');
  // A fixed three-row reservation left ~60px of blank space on a panel showing one alert.
  assert.doesNotMatch(src,/\.alerts\{[^}]*min-height:90px/, 'the alert block must size to its rows');
  assert.match(src,/alerts\.style\.minHeight=/, 'and set that size from the row count');
});
