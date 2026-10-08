import {DEFAULTS} from './shared.mjs';
import {t} from './i18n.mjs';

// State notifications handle start/stop immediately. Poll only while visible and
// running, to update metrics and recover if the page controller disconnects.
export function createOverlayMonitor({rpc,createView,schedule=setTimeout,cancel=clearTimeout}) {
  let config={...DEFAULTS},status={running:false},view,timer,revision=0,active=true,disposed=false;
  function invalidate(){revision++;cancel(timer);timer=undefined;}
  function hide(){view?.destroy();view=undefined;}
  function render(){
    if(disposed || !active || !config.showOverlay || !status.running){hide();return;}
    view??=createView();view.render(status,config);
  }
  async function refresh(){
    invalidate();
    if(disposed || !active || !config.showOverlay){hide();return;}
    const ticket=revision;
    try{
      const next=await rpc({type:'OVERLAY_STATUS'});
      if(ticket!==revision || disposed)return;
      status=next;
      config={...config,hotkey:next.hotkey??config.hotkey,language:next.language??config.language,providerName:next.providerName??config.providerName,showOverlay:next.showOverlay??config.showOverlay};
      render();
      if(view)timer=schedule(refresh,1500);
    }catch{
      if(ticket===revision){status={running:false};hide();}
    }
  }
  return {
    configure(next){invalidate();config={...config,...next};if(view)render();return refresh();},
    changed(running){invalidate();if(!running){status={running:false};hide();}else return refresh();},
    setActive(value){invalidate();active=value;if(active)return refresh();hide();},
    refresh,
    dispose(){disposed=true;invalidate();hide();},
  };
}

export function clampPosition(position,width,height,viewportWidth,viewportHeight){
  const edge=8;
  return {x:Math.max(edge,Math.min(position.x,Math.max(edge,viewportWidth-width-edge))),y:Math.max(edge,Math.min(position.y,Math.max(edge,viewportHeight-height-edge)))};
}

// Kept only for this page lifetime; restarting autopilot preserves placement.
let placement={x:16,y:84},collapsed=false;

// Every kind the player actually emits gets its own label. A kind with no label fell back to a bare
// "event" row, which is what made real reports show rows with a timestamp and nothing else.
const KIND_LABEL = key => ({
  start:'evStart',decision:'evDecision',action:'evAction',command:'evCommand',wait:'evWait',error:'evError',stop:'evStop',
  micro:'event_micro',place:'event_place',camera:'event_camera',stale:'event_stale',outcome:'event_outcome',
}[key] ?? 'evEvent');
// A tone per kind, so a glance down the list separates what the model decided from what happened.
const KIND_TONE = key => ({action:'',command:'cmd',micro:'cmd',camera:'dim',place:'dim',stale:'warn',error:'bad',outcome:'ok'}[key] ?? 'dim');
const THREAT_CLASS = threat => threat==='critical'?'threat-critical':threat==='suppressed'||threat==='pressure'?'threat-warn':'threat-clear';

// The overlay is the only surface that has to read at a glance over live gameplay, so the layout is
// deliberately denser and more colour-coded than the popup: a tinted header, a three-cell metric
// strip, then one card per topic, with numbers coloured only when they deserve attention.
// Queue rows shown at once. A busy base rarely has more than one or two, and the panel has a
// one-screen budget: measured worst case (three simultaneous alerts plus a critical threat) is
// 298x512 without this block, so three rows would push it to 549 and cost the stop-shortcut footer
// its place. Two rows keep every measured state inside the budget, and anything beyond that is
// summarised rather than listed.
const QUEUE_ROWS = 2;
// Execution records shown at once. Two is what the player can read while looking at the battle: it is
// enough to see what just happened and what preceded it, and it keeps the box at a fixed 46px so the
// sections below never move. A new record animates the row in and drops the oldest.
const RECORD_ROWS = 2;
export function createOverlayView(){
  const host=document.createElement('div');host.id='werhd-jev-overlay';
  host.style.cssText='all:initial!important;position:fixed!important;z-index:2147483646!important;display:block!important;';
  const root=host.attachShadow({mode:'closed'});
  root.innerHTML=`<style>
    :host{color-scheme:dark}*{box-sizing:border-box}
    section{width:min(298px,calc(100vw - 16px));border:1px solid #c8ab6b3d;border-radius:12px;
      background:linear-gradient(180deg,rgba(17,29,38,.93),rgba(10,19,26,.91));color:#eaf0f0;
      box-shadow:0 10px 30px #0000005c,0 1px 0 #ffffff0f inset;backdrop-filter:blur(12px) saturate(1.15);
      font:11.5px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
    section:hover,section:focus-within{background:linear-gradient(180deg,rgba(17,29,38,.98),rgba(10,19,26,.97))}
    section::before{content:'';display:block;height:2px;background:linear-gradient(90deg,#d9b76f,#91cbb188 55%,transparent)}
    header{display:flex;align-items:center;padding:8px 11px 6px;gap:8px}
    .drag{flex:1;min-width:0;cursor:grab;touch-action:none;user-select:none;border-radius:6px;outline-offset:3px}
    .drag:active{cursor:grabbing}
    .brand{color:#d9b76f;font-size:9px;letter-spacing:1.3px;line-height:1.2;font-weight:600}
    .status{font-size:13.5px;font-weight:650;display:flex;align-items:center;gap:6px;margin-top:1px}
    .dot{width:7px;height:7px;border-radius:50%;background:#91cbb1;flex:none;box-shadow:0 0 0 3px #91cbb126;animation:pulse 2.6s ease-in-out infinite}
    @keyframes pulse{0%,100%{box-shadow:0 0 0 3px #91cbb126}50%{box-shadow:0 0 0 6px #91cbb109}}
    @media (prefers-reduced-motion:reduce){.dot{animation:none}}
    button{border:1px solid #8b9c9f45;border-radius:7px;background:#ffffff08;color:#dfe8e8;font:15px/1 system-ui;cursor:pointer;min-width:25px;height:25px;transition:background .15s,border-color .15s}
    button:hover{background:#ffffff1c;border-color:#c8ab6b66}
    :focus-visible{outline:2px solid #d9b76f}
    .details{max-height:min(620px,calc(100vh - 46px));overflow-y:auto;overscroll-behavior:contain;padding:0 11px 8px;scrollbar-width:thin;scrollbar-color:#8b9c9f40 transparent}
    .details::-webkit-scrollbar{width:5px}.details::-webkit-scrollbar-thumb{background:#8b9c9f40;border-radius:3px}
    .sec{color:#cdc09b;font-size:9px;letter-spacing:1.2px;font-weight:600;margin:9px 0 4px;display:flex;align-items:center;gap:6px}
    .sec::before{content:'';width:2px;height:9px;border-radius:1px;background:#d9b76f;flex:none}
    .sec::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,#84999b33,transparent)}
    /* The tactical section carries a legend, so its text is wrapped: the ::after rule would otherwise
       sit between the title and the legend instead of after both. */
    .sec .sec-text{flex:none}
    .sec .legend{flex:none;margin-left:2px;letter-spacing:0}
    .hint{color:#7f9095;font-size:8.5px;line-height:1.35;margin:-1px 0 3px}
    #sit-hint{color:#7f9095;font-size:9px;line-height:1.4;border:1px dashed #84999b3a;border-radius:6px;padding:9px;margin:7px 0 0}
    .strip{display:grid;grid-template-columns:1fr 1fr 1fr;border:1px solid #84999b26;border-radius:9px;background:#ffffff09;overflow:hidden}
    .strip .cell{padding:6px 9px;min-width:0}
    .strip .cell+.cell{border-left:1px solid #84999b1f}
    .strip b{font-size:16.5px;line-height:1.15;font-variant-numeric:tabular-nums;font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .strip span{color:#93a6a9;font-size:9px;display:block;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .strip .cell.hot b{color:#e8a08d}.strip .cell.warm b{color:#e3b26b}
    .threat{display:flex;flex-direction:column;gap:2px;font-size:10.5px;padding:5px 9px;border-radius:9px;background:#ffffff09;border:1px solid #84999b26}
    .threat.threat-warn{background:#e3b26b12;border-color:#e3b26b3d}
    .threat.threat-critical{background:#e07b6b14;border-color:#e07b6b47}
    .threat .t-main{display:flex;align-items:center;gap:6px;font-weight:600;line-height:1.4}
    .threat .t-dot{width:6px;height:6px;border-radius:50%;flex:none;background:#91cbb1}
    .threat.threat-warn .t-dot{background:#e3b26b}.threat.threat-critical .t-dot{background:#e88a76}
    .threat .t-detail{color:#9fb1b3;font-size:9.5px;line-height:1.45;margin-top:1px;overflow-wrap:anywhere;padding-left:12px;min-height:28px}
    .sit{display:grid;grid-template-columns:repeat(3,1fr);gap:7px 9px;margin-top:7px}
    .sit>div{min-width:0}
    .sit b{font-size:13.5px;font-weight:600;display:block;font-variant-numeric:tabular-nums;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sit span{color:#93a6a9;font-size:8.5px;line-height:1.2;display:block;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sit>div.hot b{color:#e8a08d}.sit>div.warm b{color:#e3b26b}.sit>div.cool b{color:#9ec6d8}
    /* Exactly two rows, newest first: the panel cannot grow with the match. The list is no longer
       scrollable -- a new record pushes the older one out with a slide+fade instead, because a list
       that shifts under the cursor during a fight is unreadable. 2 x 22px with the inset separator
       on the second row is the 46px the box is pinned to. */
    .records{list-style:none;margin:0;padding:0;height:46px;overflow:hidden;border:1px solid #84999b22;border-radius:9px;background:#ffffff08}
    .records li{display:flex;gap:7px;height:22px;padding:0 9px;font-size:9.8px;line-height:22px;align-items:baseline;white-space:nowrap;animation:rowIn .28s ease-out}
    @keyframes rowIn{from{opacity:0;transform:translateY(-9px)}to{opacity:1;transform:none}}
    @media (prefers-reduced-motion:reduce){.records li{animation:none}}
    .records li+li{box-shadow:inset 0 1px 0 #84999b17}
    .records time{color:#7f9095;flex:none;font-variant-numeric:tabular-nums}
    .records .mark{flex:none;width:9px;text-align:center;color:#6f8489;font-size:8px}
    .records .mark.ok{color:#8fd0a8;font-size:10px}.records .mark.bad{color:#e88a76;font-size:10px}
    .records .what{color:#d5e0e0;min-width:0;overflow:hidden;text-overflow:ellipsis}
    .records .what .lbl{color:#cdc09b;font-weight:600}
    .records .what .lbl.cmd{color:#9ec6d8}.records .what .lbl.dim{color:#93a6a9}.records .what .lbl.warn{color:#e3b26b}
    .records .what .lbl.bad{color:#e88a76}.records .what .lbl.ok{color:#8fd0a8}
    .records .empty{color:#93a6a9;height:auto;line-height:1.4;padding:9px;display:block;border:1px dashed #84999b3a;border-radius:6px}
    /* Two blocks change with what the base and the model are doing, and a panel that resizes mid-fight
       is hard to read: everything below the jump shifts. Each is reserved at its largest useful size
       instead - three alerts, and two queue rows plus the overflow line - so the height is constant
       for the whole of a match. Content that fits is padded out; only a genuinely long error message
       still grows the panel, which is the one case where the extra height earns its place. */
.alerts{display:flex;flex-direction:column;gap:4px;min-height:90px}
    .alert{border-radius:9px;padding:5px 9px;font-size:10.5px;line-height:1.45;display:flex;gap:7px;align-items:flex-start}
    .alert .ic{flex:none;font-size:9.5px;line-height:1.6}
    .alert.error{background:#e07b6b1c;border:1px solid #e07b6b4d;color:#f2bcb1}
    .alert.warn{background:#e3b26b1c;border:1px solid #e3b26b45;color:#f0d3a8}
    .alert.none{background:transparent;border:0;padding:1px 1px 0;color:#8fa3a5;font-size:9.8px}
    .queues{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;min-height:70px}
    .queues li{display:flex;align-items:center;gap:8px;height:24px;padding:0 9px;font-size:10px;line-height:24px;border:1px solid #84999b22;border-radius:9px;background:#ffffff08}
    .queues .q-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d5e0e0}
    .queues .q-bar{flex:none;width:52px;height:4px;border-radius:2px;background:#84999b2b;overflow:hidden}
    .queues .q-bar i{display:block;height:100%;border-radius:2px;background:#d9b76f}
    .queues .q-value{flex:none;width:29px;text-align:right;color:#93a6a9;font-size:9px;font-variant-numeric:tabular-nums}
    .queues li.empty{display:block;text-align:center;color:#93a6a9;border-style:dashed}
    .queues li.q-more{height:16px;line-height:16px;border:0;background:none;justify-content:center;color:#7f9095;font-size:9px;padding:0}
    .foot{display:flex;justify-content:flex-end;gap:8px;margin-top:7px;font-size:9.5px;color:#93a6a9}
    /* Tactical sketch: the same schematic the popup draws, scaled to the overlay's width. It answers
       "where is the fight" without a minimap, which the page already has. */
    .map{position:relative;border:1px solid #84999b26;border-radius:9px;background:#ffffff06;overflow:hidden}
    .map svg{display:block;width:100%;height:auto}
    .map .grid{stroke:#84999b1f;stroke-width:1}
    .map .own{fill:#91cbb1}.map .foe{fill:#ed9383}.map .home{fill:#d9b76f}
    .legend{display:flex;gap:9px;font-size:8.5px;color:#8fa3a5;white-space:nowrap}
    .legend i{display:inline-block;width:5px;height:5px;border-radius:50%;margin-right:3px;vertical-align:1px}
    .legend .own i{background:#91cbb1}.legend .foe i{background:#ed9383}.legend .home i{background:#d9b76f}
    .shortcut{color:#d9b76f}
    .warning{color:#e8bd8c;margin:5px 0 0;font-size:10px}
    [hidden]{display:none!important}
  </style><section aria-label="Jev"><header><div class="drag" tabindex="0" role="group"><div class="brand"></div><div class="status"><i class="dot"></i><span class="status-text"></span></div></div><button type="button"></button></header><div class="details"><div class="sec" id="sec-alerts"></div><div class="alerts" id="alerts"></div><div class="strip"><div class="cell" id="cell-decisions"><b id="decisions"></b><span id="decisions-label"></span></div><div class="cell"><b id="credits"></b><span id="credits-label"></span></div><div class="cell" id="cell-latency"><b id="latency"></b><span id="latency-label"></span></div></div><div class="sec" id="sec-situation"></div><div class="threat" id="threat" hidden></div><div class="sit" id="sit"><div id="cell-army"><b id="army"></b><span id="army-label"></span></div><div id="cell-enemies"><b id="enemies"></b><span id="enemies-label"></span></div><div id="cell-nearby"><b id="nearby"></b><span id="nearby-label"></span></div><div id="cell-miners"><b id="miners"></b><span id="miners-label"></span></div><div id="cell-health"><b id="health"></b><span id="health-label"></span></div><div id="cell-power"><b id="power"></b><span id="power-label"></span></div></div><p class="hint" id="sit-hint" hidden></p><div class="sec" id="sec-records"></div><div class="hint" id="records-hint" hidden></div><ol class="records" id="records"></ol><div class="sec" id="sec-queues"></div><ol class="queues" id="queues"></ol><div class="sec" id="sec-map"><span class="sec-text"></span><span class="legend" id="map-legend"><span><i class="own"></i><span class="lg-own"></span></span><span><i class="foe"></i><span class="lg-foe"></span></span><span><i class="home"></i><span class="lg-home"></span></span></span></div><div class="map" id="map"></div><p class="hint" id="map-hint"></p><div class="foot"><span class="shortcut"></span></div><p class="warning" hidden></p></div></section>`;
  const $=selector=>root.querySelector(selector),handle=$('.drag'),button=$('button');
  let config,lastStatus,drag,lastRecordKey='';
  const recordsBox=$('#records');
  function layout(){
    const box=host.getBoundingClientRect();placement=clampPosition(placement,box.width,box.height,window.innerWidth,window.innerHeight);
    host.style.setProperty('left',`${placement.x}px`,'important');host.style.setProperty('top',`${placement.y}px`,'important');
  }
  function attach(){(document.fullscreenElement??document.documentElement).append(host);layout();}
  function render(status,next){
    config=next;lastStatus=status;const name=config.providerName||'Jev',tr=key=>t(config.language,key,{name});
    const tr2=(key,params={})=>t(config.language,key,{name,...params});
    const format=n=>Number.isFinite(n)?Math.round(n).toLocaleString(config.language):'—';
    const o=status.observation??null;
    host.lang=config.language;$('section').setAttribute('aria-label',tr('title'));
    $('.brand').textContent=`${name.toUpperCase()} · ${tr('officialWebsite')}`;$('.status-text').textContent=tr('running');
    handle.title=tr('overlayDrag');handle.setAttribute('aria-label',`${tr('running')} · ${tr('overlayDrag')}`);
    button.textContent=collapsed?'+':'−';button.title=tr(collapsed?'overlayExpand':'overlayCollapse');button.setAttribute('aria-label',button.title);button.setAttribute('aria-expanded',String(!collapsed));
    $('.details').hidden=collapsed;
    // Real-time execution alerts. The dropped-reply count is the one that explains a quiet match:
    // a slow model's answer is thrown away once the game has moved on, so "it did nothing" and
    // "it answered too late" have to be told apart here rather than guessed at afterwards.
    $('#sec-alerts').textContent=tr('overlayAlerts');
    const alerts=$('#alerts');alerts.innerHTML='';
    const alert=(tone,icon,text)=>{const div=document.createElement('div');div.className=`alert ${tone}`;
      const ic=document.createElement('i');ic.className='ic';ic.textContent=icon;
      const body=document.createElement('span');body.textContent=text;div.append(ic,body);alerts.append(div);};
    if(status.error)alert('error','▲',tr2('overlayError',{error:String(status.error).slice(0,120)}));
    if(status.failures)alert('warn','▲',tr2('overlayAlertsCount',{n:status.failures}));
    if(status.rejected)alert('warn','!',tr2('overlayDropped',{n:status.rejected}));
    if(!alerts.children.length)alert('none','✓',tr('overlayNoAlerts'));
    for(const key of ['decisions','credits','latency'])$(`#${key}-label`).textContent=tr(key);
    $('#decisions').textContent=format(status.decisions??0);$('#credits').textContent=format(status.credits);
    // Latency is coloured because it is actionable, not decorative: past roughly three seconds of
    // wall clock the game has moved on and the reply is discarded as stale.
    $('#latency').textContent=Number.isFinite(status.latencyMs)?`${format(status.latencyMs)}ms`:'—';
    $('#cell-latency').className=`cell${!Number.isFinite(status.latencyMs)?'':status.latencyMs>=3000?' hot':status.latencyMs>=2000?' warm':''}`;
    // Battlefield situation: threat level plus a compact force / power grid.
    $('#sec-situation').textContent=tr('overlaySituation');
    const threat=$('#threat');threat.hidden=!o;
    // With nothing observed yet there is no grid to show, and six em dashes read as a fault rather
    // than as "the match has not started".
    $('#sit').hidden=!o;$('#sit-hint').hidden=!!o;$('#sit-hint').textContent=tr('overlayNoSituation');
    if(o){const level=o.threat??'clear';threat.className=`threat ${THREAT_CLASS(level)}`;
      const detail=[tr(level==='critical'||level==='pressure'?'pressureDetail':'clearDetail'),o.rangeThreats>0?tr2('overlayRangeThreats',{n:o.rangeThreats}):'',Number.isFinite(o.gameSeconds)?tr2('overlayGameSeconds',{s:format(o.gameSeconds)}):''].filter(Boolean).join(' · ');
      const main=document.createElement('div');main.className='t-main';
      const dot=document.createElement('i');dot.className='t-dot';
      const head=document.createElement('span');head.textContent=`${tr('overlayThreat')} · ${tr(level==='critical'?'critical':level==='suppressed'?'suppressed':level==='pressure'?'pressure':'clear')}`;
      main.append(dot,head);
      const body=document.createElement('div');body.className='t-detail';body.textContent=detail;
      threat.replaceChildren(main,body);}
    for(const [id,key,labelKey] of [['army','army','army'],['enemies','visibleEnemies','visible'],['nearby','nearbyEnemies','nearby'],['miners','harvesters','miners'],['health','health','health'],['power','power','power']]){
      $(`#${id}-label`).textContent=tr(labelKey);
      $(`#${id}`).textContent=key==='health'?(Number.isFinite(o?.health)?`${format(o.health)}%`:'—'):key==='power'?(o?.power&&Number.isFinite(o.power.total)?`${format(o.power.total)} / ${format(o.power.drain)}`:'—'):o?format(o[key]):'—';
    }
    // Colour only what needs attention: enemies in sight, a base under pressure, power in deficit.
    const count=k=>Number.isFinite(o?.[k])?o[k]:0;
    $('#cell-enemies').className=`${count('visibleEnemies')>0?'hot':''}`;
    $('#cell-nearby').className=`${count('nearbyEnemies')>0?'hot':''}`;
    const powerLow=!!o?.power&&Number.isFinite(o.power.total)&&Number.isFinite(o.power.drain)&&o.power.total<o.power.drain;
    $('#cell-power').className=`${powerLow?'warm':''}`;
    $('#cell-army').className=`${count('army')>0?'cool':''}`;
    // Execution records: structured and sanitized, newest first, two rows only.
    $('#sec-records').textContent=tr('overlayLog');
    const execs=(status.executions??[]).slice(0,RECORD_ROWS);
    const hasRecords=execs.length>0;
    $('#records-hint').hidden=true;
    // Rebuilding the rows on every 1.5 s poll would replay the entry animation each time and make the
    // panel look permanently mid-transition. The rows are only rebuilt when the newest entry actually
    // changes, so the animation means "a new record arrived" and nothing else.
    const newest=hasRecords?`${execs[0].at}|${execs.length}`:'';
    if(newest!==lastRecordKey){
      lastRecordKey=newest;
      recordsBox.innerHTML='';
      if(!hasRecords){const li=document.createElement('li');li.className='empty';li.textContent=tr('overlayNoLog');recordsBox.append(li);}
      else for(const e of execs){
      const li=document.createElement('li');
      // 24-hour, fixed width: a 12-hour clock adds "AM/PM" to every row and the panel is narrow.
      const time=document.createElement('time');time.textContent=new Date(e.at).toLocaleTimeString(config.language,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
      const mark=document.createElement('span');mark.className=`mark ${e.kind==='action'?(e.accepted?'ok':'bad'):''}`;
      mark.textContent=e.kind==='action'?(e.accepted?'✓':'✗'):'●';
      const label=tr(KIND_LABEL(e.kind));
      const what=document.createElement('span');what.className='what';
      const lbl=document.createElement('span');lbl.className=`lbl ${KIND_TONE(e.kind)}`;lbl.textContent=label;
      // One value per meaning: the server echoes the choice into several fields, and the raw kind is
      // not worth repeating, so duplicates and the label itself are dropped.
      const parts=[];for(const v of [e.text,e.choice,e.actionType,e.reason]){const text=String(v??'').trim();
        if(text&&text!==label&&text!==e.kind&&!parts.includes(text))parts.push(text);}
      what.append(lbl);if(parts.length)what.append(document.createTextNode(` · ${parts.join(' · ')}`));
      // The row is a fixed single line: a long report is ellipsized here and kept in the tooltip,
      // so no row can grow the panel.
      what.title=[label,...parts].join(' · ');
      li.append(time,mark,what);recordsBox.append(li);}
    }
    // What the base is producing. This is the one block that answers "what is it actually doing",
    // and the quickest read on whether the economy keeps growing: an idle base says so in one line
    // instead of showing the handful of queues that happen to exist. Names arrive resolved from the
    // background, so nothing here has to know that "E2" is a Chrono Miner.
    $('#sec-queues').textContent=tr('production');
    const queueBox=$('#queues');queueBox.innerHTML='';
    // Before the first observation there is nothing to report, and "nothing in production" would be a
    // claim about the base rather than about the data. The block stays hidden until real data exists,
    // the same way the situation grid does.
    $('#sec-queues').hidden=!o;queueBox.hidden=!o;
    const rows=o?(o.queues??[]).flatMap(q=>q.items??[]):[];
    if(o){
      if(!rows.length){const li=document.createElement('li');li.className='empty';li.textContent=tr('queueEmpty');queueBox.append(li);}
      else for(const item of rows.slice(0,QUEUE_ROWS)){
        const li=document.createElement('li');
        const name=document.createElement('span');name.className='q-name';
        // The label is the game's own display name; the kind is the fallback for anything unmapped.
        const shown=item.label||item.kind||'?';
        const many=Number.isFinite(item.quantity)&&item.quantity>1;
        name.textContent=many?`${shown} ×${item.quantity}`:shown;name.title=name.textContent;
        const pct=Number.isFinite(item.progress)?Math.max(0,Math.min(1,item.progress)):null;
        const bar=document.createElement('span');bar.className='q-bar';bar.setAttribute('aria-hidden','true');
        const fill=document.createElement('i');fill.style.width=pct===null?'0%':`${Math.round(pct*100)}%`;bar.append(fill);
        const value=document.createElement('span');value.className='q-value';value.textContent=pct===null?'—':`${Math.round(pct*100)}%`;
        li.append(name,bar,value);queueBox.append(li);
      }
      if(rows.length>QUEUE_ROWS){const li=document.createElement('li');li.className='q-more';li.textContent=tr2('overlayMoreQueues',{n:rows.length-QUEUE_ROWS});queueBox.append(li);}
    }
    // Tactical sketch, same data and projection as the popup's: visible units on both sides plus our
    // base, auto-scaled to fit. It is a schematic, not a map -- the caption says so, because a player
    // who reads it as a minimap will look for units it deliberately left out.
    $('#sec-map .sec-text').textContent=tr('tactical');
    $('.lg-own').textContent=tr('own');$('.lg-foe').textContent=tr('enemy');$('.lg-home').textContent=tr('base');
    const mapBox=$('#map');
    // The legend lives inside the section header, so hiding the section hides both; the box and the
    // caption are siblings and are hidden on their own.
    $('#sec-map').hidden=!o;mapBox.hidden=!o;$('#map-hint').hidden=!o;
    if(o){
      const own=o.ownPoints??[],foe=o.enemyPoints??[],base=o.base;
      $('#map-hint').textContent=tr('tacticalHint');
      if(!(own.length||foe.length||base)){
        mapBox.replaceChildren();
      } else {
        const all=[...own,...foe,...(base?[base]:[])];
        const xs=all.map(p=>p.x),ys=all.map(p=>p.y);
        const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
        // 340x112 in the popup; kept identical so the two read as the same drawing at different sizes.
        const scale=Math.min(304/Math.max(12,maxX-minX),80/Math.max(12,maxY-minY));
        const px=p=>170+(p.x-(minX+maxX)/2)*scale,py=p=>56+(p.y-(minY+maxY)/2)*scale;
        const NS='http://www.w3.org/2000/svg';
        const svg=document.createElementNS(NS,'svg');
        svg.setAttribute('viewBox','0 0 340 112');svg.setAttribute('role','img');
        svg.setAttribute('aria-label',tr('tactical'));
        const add=(tag,attrs)=>{const n=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;};
        for(let i=18;i<340;i+=38)svg.append(add('line',{x1:i,x2:i,y1:8,y2:104,class:'grid'}));
        for(let i=18;i<112;i+=24)svg.append(add('line',{x1:12,x2:328,y1:i,y2:i,class:'grid'}));
        for(const p of own)svg.append(add('circle',{cx:px(p),cy:py(p),r:3.3,class:'own'}));
        for(const p of foe)svg.append(add('circle',{cx:px(p),cy:py(p),r:3.3,class:'foe'}));
        if(base)svg.append(add('rect',{x:px(base)-4,y:py(base)-4,width:8,height:8,class:'home',transform:`rotate(45 ${px(base)} ${py(base)})`}));
        mapBox.replaceChildren(svg);
      }
    }
    $('.shortcut').textContent=`${config.hotkey} · ${tr('stop')}`;
    layout();
  }
  button.addEventListener('click',()=>{collapsed=!collapsed;render(lastStatus,config);});
  handle.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();drag={id:e.pointerId,startX:e.clientX,startY:e.clientY,...placement};handle.setPointerCapture(e.pointerId);});
  handle.addEventListener('pointermove',e=>{if(!drag || drag.id!==e.pointerId)return;placement={x:drag.x+(e.clientX-drag.startX),y:drag.y+(e.clientY-drag.startY)};layout();});
  const endDrag=()=>{drag=undefined;};handle.addEventListener('pointerup',endDrag);handle.addEventListener('lostpointercapture',endDrag);window.addEventListener('blur',endDrag);
  handle.addEventListener('keydown',e=>{const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(!delta)return;e.preventDefault();placement={x:placement.x+delta[0]*16,y:placement.y+delta[1]*16};layout();});
  // Panel interactions must not become game clicks, scrolls or movement keys.
  for(const type of ['pointerdown','pointerup','pointermove','mousedown','mouseup','click','dblclick','contextmenu','keydown','keyup','wheel'])host.addEventListener(type,e=>e.stopPropagation());
  window.addEventListener('resize',layout);document.addEventListener('fullscreenchange',attach);attach();
  return {render,destroy(){host.remove();window.removeEventListener('resize',layout);window.removeEventListener('blur',endDrag);document.removeEventListener('fullscreenchange',attach);}};
}
