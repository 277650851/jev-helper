import test from 'node:test';
import assert from 'node:assert/strict';
import {apiEndpoint,originPattern,hostPattern,validateSettings,publicSettings,normalizeHotkey,hotkeyFromEvent,prepareQuestions,prepareBrief,validateAnswer,supportedGame,GAME_HOSTS,activeProvider,authHeaders,httpError,fieldErrors,errorField,plaintextPublic,hostAllowed,normalizeHost,sanitizeAllowedHosts,BODY_MAX_BYTES,BRIEF_MAX_BYTES,jsonBytes} from '../src/shared.mjs';
import {choiceSchema} from '../src/openai.mjs';
test('API configuration accepts a base/full endpoint, confines plaintext to loopback and strips no secret into public settings',()=>{
  assert.equal(apiEndpoint('https://api.typesafe.ai/v1/'),'https://api.typesafe.ai/v1/systemone');
  assert.equal(apiEndpoint('https://example.test/proxy/systemone'),'https://example.test/proxy/systemone');
  assert.equal(originPattern('http://127.0.0.1:8742/v1'),'http://127.0.0.1/*');
  assert.equal(apiEndpoint('http://192.168.1.20:8742/v1'),'http://192.168.1.20:8742/v1/systemone');assert.equal(originPattern('http://10.0.0.5:8742/v1'),'http://10.0.0.5/*');assert.equal(apiEndpoint('http://mac-studio.local:8742/v1'),'http://mac-studio.local:8742/v1/systemone');
  // Any reachable address is accepted; only the plaintext-over-public warning distinguishes networks.
  for(const quiet of ['http://100.118.47.84:8742/v1','http://100.64.0.1/v1','http://100.127.255.254/v1','http://mac-studio.tail1234.ts.net:8742/v1','http://mac-studio:8742/v1','http://nas.lan/v1','http://box.home.arpa/v1','http://169.254.10.10/v1','http://[fd7a:115c:a1e0::1]:8742/v1','http://[fe80::1]/v1','http://172.31.255.1/v1','https://example.com/v1']){assert.doesNotThrow(()=>apiEndpoint(quiet),quiet);assert.equal(plaintextPublic(quiet),false,quiet);}
  for(const warned of ['http://example.com/v1','http://8.8.8.8/v1','http://172.32.0.1/v1','http://100.128.0.1/v1','http://100.63.255.255/v1','http://api.typesafe.ai/v1','http://[2001:db8::1]/v1','http://my-vps.example.org:8742/v1']){assert.doesNotThrow(()=>apiEndpoint(warned),warned);assert.equal(plaintextPublic(warned),true,warned);}
  for(const bad of ['ftp://example.com/v1','https://secret@example.com/v1','https://example.com/?key=secret','file:///tmp/api','https://example.com/#x','not a url'])assert.throws(()=>apiEndpoint(bad),bad);
  assert.equal('apiKey' in publicSettings(validateSettings({apiKey:'test-only-secret'})),false);
  assert.equal(supportedGame('https://ra2web.github.io/'),true);assert.equal(supportedGame('https://ra2web.github.io.evil.test/'),false);
});
test('a missing player API explains both causes instead of blaming the match',async()=>{
  const fs=await import('node:fs/promises');
  const page=await fs.readFile('src/page.mjs','utf8');
  const {errorText}=await import('../src/i18n.mjs');
  // The page sees one state — no window.werhd — with two causes it cannot separate: the match has
  // not started, or this build never ships the public API. So the message has to name both;
  // telling a lobby visitor their game version is unsupported would be wrong on every site.
  const m=/error:'([^']*玩家 API[^']*)'/.exec(page);
  assert.ok(m,'the no-API message names the API');
  const message=m[1];
  assert.match(message,/尚未进入对局/,message);
  assert.match(message,/缺少所需玩家 API/,message);
  assert.doesNotMatch(message,/请先进入一场正在运行的对局。$/,'not the old lobby-only wording');
  // Every message the page can return has to be translatable, or English users see Chinese.
  for(const text of [...page.matchAll(/error:'([^']+)'/g)].map(x=>x[1])){
    assert.ok(errorText('en',text),`missing English translation: ${text}`);
    assert.doesNotMatch(errorText('en',text),/[\u3400-\u9fff]/,`English text still has Chinese: ${text}`);
  }
});

test('the popup title names the selected model source instead of always saying Jev',async()=>{
  const {messages,t}=await import('../src/i18n.mjs');
  // Both the browser tab title and the header use this key, with the source's name substituted.
  for(const pair of [messages.title,messages.helpTitle]){
    const [zh,en]=pair;
    assert.ok(zh.includes('{name}')&&en.includes('{name}'),'the name is a placeholder, not a literal');
    assert.ok(!/Jev 对局托管|Let Jev play/.test(zh+en),'no provider name is baked into the text');
  }
  assert.equal(t('zh-CN','title',{name:'Laya'}),'Laya 对局托管');
  assert.equal(t('en','title',{name:'OpenAI'}),'OpenAI Autopilot');
  assert.equal(t('zh-CN','helpTitle',{name:'Laya'}),'把当前对局交给 Laya。');
  // Every provider name in shared.mjs has to read naturally in the title.
  const {activeProvider,validateSettings}=await import('../src/shared.mjs');
  for(const provider of ['jev','local','openai']){
    const {name}=activeProvider(validateSettings({provider}));
    const text=t('en','title',{name});
    assert.ok(text.endsWith(' Autopilot'),text);
    assert.ok(!text.includes('{name}'),text);
  }
  // The built pages must not ship a hard-coded Jev heading any more.
  const popup=await (await import('node:fs/promises')).readFile('dist/popup.js','utf8');
  assert.doesNotMatch(popup,/['"`]Jev 对局托管['"`]/,'the popup builds the title from the provider');
  const help=await (await import('node:fs/promises')).readFile('dist/help.js','utf8');
  assert.doesNotMatch(help,/['"`]Jev 对局托管['"`]/,'the help page builds the title from the provider');
});

test('every game host is accepted over https only, and the manifest asks for exactly those',async()=>{
  const fs=await import('node:fs/promises');
  const manifest=JSON.parse(await fs.readFile('public/manifest.json','utf8'));
  const expected=['ra2web.github.io','staging.wangerhuoda.com','wangerhuoda.com','www.wangerhuoda.com','gonghui.k0s.cn','game.ra2web.com','wan.youlidefuchou.com'];
  assert.deepEqual([...GAME_HOSTS].sort(),[...expected].sort());
  for(const host of GAME_HOSTS){
    assert.equal(supportedGame(`https://${host}/`),true,host);
    assert.equal(supportedGame(`https://${host}/battle/1`),true,host);
    // A look-alike suffix, a subdomain and plain http must all stay unsupported.
    assert.equal(supportedGame(`https://${host}.evil.test/`),false,host);
    assert.equal(supportedGame(`https://x.${host}/`),false,host);
    assert.equal(supportedGame(`http://${host}/`),false,host);
    // Content script and host permissions have to cover it, or the page never sees the extension.
    assert.ok(manifest.content_scripts[0].matches.includes(`https://${host}/*`),`content script matches ${host}`);
    assert.ok(manifest.host_permissions.includes(`https://${host}/*`),`host permission for ${host}`);
  }
  // GAME_HOSTS is the single source of truth for the game's origins: nothing else is requested.
  // `expected` above is exact, so removing a host here retires it from both files at once.
  const gameOrigins=manifest.host_permissions.filter(p=>!p.includes('api.typesafe.ai'));
  assert.deepEqual(gameOrigins.sort(),GAME_HOSTS.map(h=>`https://${h}/*`).sort());
  assert.equal(gameOrigins.length,manifest.content_scripts[0].matches.length);
});
test('custom keyboard chord uses physical keys and exact modifiers',()=>{
  assert.equal(normalizeHotkey('alt+SHIFT+j'),'Alt+Shift+J');
  assert.equal(hotkeyFromEvent({code:'KeyJ',altKey:true,shiftKey:true,key:'Ô'}),'Alt+Shift+J');
  assert.equal(hotkeyFromEvent({code:'KeyJ',metaKey:true}),'Meta+J');
  for(const bad of ['J','Shift+J','Bogus+J','Ctrl+Bogus+J'])assert.throws(()=>normalizeHotkey(bad));
});
test('Jev results are constrained to the submitted candidate set',()=>{
  const questions=prepareQuestions({state:{tick:1},groups:{tactics:{instructions:'Select',criteria:{wait:'Wait',attack:'Attack'}}}});
  assert.throws(()=>validateAnswer({answers:{tactics:{type:'choice',choice:'sell_everything'}}},questions));
  assert.throws(()=>validateAnswer({answers:{}},questions));
  const result=validateAnswer({answers:{tactics:{type:'choice',choice:'attack'},injected:{choice:'bad'}},apiKey:'malicious'},questions);
  assert.deepEqual(Object.keys(result.answers),['tactics']);assert.equal('apiKey' in result,false);
  assert.throws(()=>prepareQuestions({state:{},groups:Object.fromEntries(Array.from({length:9},(_,i)=>['x'+i,{}]))}));
});
test('decision group ids that would land on the prototype are refused, so the emitted schema stays self-consistent',()=>{
  // __proto__ passes the id pattern but would hit the prototype setter instead of creating an own
  // key, leaving `required` naming a member that `properties` does not define.
  for(const id of ['__proto__','constructor','prototype']){
    const forged=JSON.parse('{"state":{"tick":1},"groups":{"'+id+'":{"instructions":"Select","criteria":{"wait":"Wait"}}}}');
    assert.throws(()=>prepareQuestions(forged),/决策候选无效/,id);
    // And the rejection happens before anything is built from the id.
    assert.throws(()=>choiceSchema(prepareQuestions(forged)),/决策候选无效/,id);
  }
  const schema=choiceSchema(prepareQuestions({state:{tick:1},groups:{tactics:{instructions:'Select',criteria:{wait:'Wait'}}}}));
  for(const id of schema.required)assert.ok(Object.hasOwn(schema.properties,id));
  assert.ok(Object.hasOwn(schema.properties,'tactics'));
});
test('request size limits are counted in UTF-8 bytes, so Chinese state cannot exceed the server bound',()=>{
  const chinese='中文战况描述';
  const group=(n)=>({tactics:{instructions:chinese.repeat(n),criteria:{wait:'等待',attack:'进攻'}}});
  // Well under the limit as characters, well over it as bytes: the byte count is the one that counts,
  // because that is what Content-Length carries and what tools/laya-server.py compares.
  const state={tick:1,notes:chinese.repeat(25000)};
  assert.ok(JSON.stringify({state,groups:group(1)}).length<BODY_MAX_BYTES);
  assert.ok(jsonBytes({state,groups:group(1)})>BODY_MAX_BYTES);
  assert.throws(()=>prepareQuestions({state,groups:group(1)}),/大小无效/);
  // A small request is unaffected, and an ASCII one gets the full character budget.
  const small=prepareQuestions({state:{tick:1,notes:'x'.repeat(1000)},groups:group(1)});
  assert.equal(small.tactics.criteria.wait,'等待');
  assert.throws(()=>prepareQuestions({state:{notes:'x'.repeat(BODY_MAX_BYTES)},groups:group(1)}),/大小无效/);
  assert.throws(()=>prepareBrief({mode:'commander',brief:{notes:'x'.repeat(BRIEF_MAX_BYTES)}}),/格式或大小无效/);
});
test('two model sources keep separate endpoints and keys; the local source needs no key and never leaks it',()=>{
  const jev=validateSettings({apiKey:'jev-secret',localKey:'local-secret'});
  assert.equal(activeProvider(jev).id,'jev');assert.equal(activeProvider(jev).apiBase,'https://api.typesafe.ai/v1');assert.equal(activeProvider(jev).apiKey,'jev-secret');assert.equal(activeProvider(jev).requiresKey,true);
  const local=validateSettings({provider:'local',apiKey:'jev-secret',localBase:'http://127.0.0.1:8742/v1/'});
  const p=activeProvider(local);assert.equal(p.id,'local');assert.equal(p.name,'Laya');assert.equal(p.requiresKey,false);assert.equal(p.apiKey,'');assert.equal(apiEndpoint(p.apiBase),'http://127.0.0.1:8742/v1/systemone');
  assert.deepEqual(authHeaders(p),{'Content-Type':'application/json'});assert.equal(authHeaders(activeProvider(jev)).Authorization,'Bearer jev-secret');
  assert.equal(validateSettings({provider:'anything-else'}).provider,'jev');
  // The pattern asked for at save time has to be one Chrome accepts: a bare host over both schemes,
  // and IPv6 literals with the brackets normalizeHost strips.
  assert.equal(hostPattern('vps.example'),'*://vps.example/*');
  assert.equal(hostPattern('FD7A:115C:A1E0::1'),'*://[fd7a:115c:a1e0::1]/*');
  for(const pattern of [hostPattern('vps.example'),hostPattern('10.0.0.5'),hostPattern('fd7a:115c:a1e0::1')])assert.match(pattern,/^(\*|https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)\/\*$/,pattern);
  const padded=validateSettings({apiBase:'  https://api.typesafe.ai/v1  ',apiKey:'  padded-key\t',localBase:' http://127.0.0.1:8742/v1 ',localKey:' t ',model:' jev-latest '});
  assert.equal(padded.apiBase,'https://api.typesafe.ai/v1');assert.equal(padded.apiKey,'padded-key');assert.equal(padded.localBase,'http://127.0.0.1:8742/v1');assert.equal(padded.localKey,'t');assert.equal(padded.model,'jev-latest');
  const raw=activeProvider({provider:'local',localBase:' http://127.0.0.1:8742/v1 ',localKey:' tok '});assert.equal(raw.apiBase,'http://127.0.0.1:8742/v1');assert.equal(authHeaders(raw).Authorization,'Bearer tok');
  assert.throws(()=>validateSettings({provider:'local',localBase:'http://example.com/v1'}),/允许的外部地址/,'public plaintext needs an explicit allow');
  assert.equal(validateSettings({provider:'local',localBase:'http://example.com/v1',allowedHosts:['Example.COM']}).localBase,'http://example.com/v1');
  assert.doesNotThrow(()=>validateSettings({provider:'local',localBase:'https://example.com/v1'}),'https public needs nothing');
  assert.doesNotThrow(()=>validateSettings({provider:'local',localBase:'http://100.118.47.84:8742/v1'}),'private networks need nothing');
  assert.equal(normalizeHost(' HTTP://Laya.Example.com:8742/v1 '),'laya.example.com');assert.equal(normalizeHost('203.0.113.5:8742'),'203.0.113.5');assert.equal(normalizeHost('[fd00::1]:8742'),'fd00::1');assert.throws(()=>normalizeHost(''));assert.throws(()=>normalizeHost('user:pw@host'));for(const junk of ['!!','not a host!!','not%20a%20host','-bad.example','host_name','a..b'])assert.throws(()=>normalizeHost(junk),junk);
  assert.deepEqual(sanitizeAllowedHosts(['a.example',' A.EXAMPLE ','bad host!!',null,'b.example']),['a.example','b.example']);assert.equal(sanitizeAllowedHosts(Array.from({length:40},(_,i)=>`h${i}.example`)).length,32);
  assert.equal(hostAllowed('http://example.com/v1',[]),false);assert.equal(hostAllowed('http://example.com/v1',['example.com']),true);assert.equal(hostAllowed('https://example.com/v1',[]),true);assert.equal(hostAllowed('http://10.1.2.3/v1',[]),true);
  assert.equal(fieldErrors({provider:'local',localBase:'http://vps.example/v1',localModel:'laya',hotkey:'Alt+J',maxDecisions:1,localKey:''}).localBase,'公网明文地址需要先加入「允许的外部地址」。');assert.equal(errorField('公网明文地址需要先加入「允许的外部地址」。','local'),'localBase');
  assert.throws(()=>validateSettings({localModel:'bad name!'}));
  const shown=publicSettings(jev);assert.equal(shown.provider,'jev');assert.equal(shown.providerName,'Jev');assert.equal(shown.hasLocalKey,true);assert.equal(shown.localBase,'http://127.0.0.1:8742/v1');
  assert.doesNotMatch(JSON.stringify(shown),/secret/);
  assert.match(httpError(401,'Laya'),/^Laya 拒绝了密钥/);assert.match(httpError(500),/^Jev 请求失败/);
  assert.throws(()=>validateAnswer({answers:{}},{tactics:{criteria:{wait:''}}},'Laya'),/Error: Laya 返回了未提供的候选/);
});
test('inline validation reports every invalid field at once and maps background errors to fields',()=>{
  const bad={provider:'jev',apiBase:'ftp://example.com/v1',apiKey:'',model:'bad name!',hotkey:'J',maxDecisions:0,localBase:'nonsense',localKey:'x\ny'};
  const errors=fieldErrors(bad,{requireKey:true});
  assert.deepEqual(Object.keys(errors).sort(),['apiBase','apiKey','hotkey','maxDecisions','model']);
  assert.equal(errors.apiKey,'请输入 JEV 密钥。');assert.match(errors.apiBase,/http/);assert.equal(errors.model,'模型名称无效。');
  assert.deepEqual(fieldErrors({...bad,provider:'local'}),{localBase:'请输入有效的 API 地址。',localModel:'模型名称无效。',hotkey:'快捷键需要 Ctrl、Alt 或 Meta 加一个字母、数字或 F1–F12。',maxDecisions:'每局决策上限应为 1–10000。',localKey:'密钥格式无效。'});
  assert.deepEqual(fieldErrors({provider:'jev',apiBase:' https://api.typesafe.ai/v1 ',model:'jev-latest',hotkey:'Alt+Shift+J',maxDecisions:2000,apiKey:''},{requireKey:false}),{});
  assert.deepEqual(fieldErrors({provider:'local',localBase:'http://127.0.0.1:8742/v1',localModel:'laya',hotkey:'Alt+Shift+J',maxDecisions:10,localKey:''},{requireKey:true}),{});
  assert.equal(errorField('请先填写并保存 JEV 密钥。'),'apiKey');assert.equal(errorField('更换 API 服务时，请重新输入该服务的密钥。'),'apiKey');
  assert.equal(errorField('请输入有效的 API 地址。'),'apiBase');assert.equal(errorField('尚未授权访问模型服务地址，请在插件中点击「授权访问」。','local'),'','authorization is not a field error');assert.equal(errorField('API 访问权限已被撤销，请重新保存设置。'),'');assert.equal(errorField('请输入有效的 API 地址。','local'),'localBase');
  assert.equal(fieldErrors({provider:'jev',apiBase:'https://api.typesafe.ai/v1',model:'m',hotkey:'Alt+J',maxDecisions:1,apiKey:'k',objective:'o'.repeat(301)}).objective,'本局目标最多 300 个字符。');assert.equal(errorField('本局目标最多 300 个字符。'),'objective');
  assert.equal(errorField('模型名称无效。','local'),'localModel');assert.equal(errorField('每局决策上限应为 1–10000。'),'maxDecisions');assert.equal(errorField('托管未能启动。'),'');
});
