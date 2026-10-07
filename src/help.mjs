import {t,officialWebsiteUrl} from './i18n.mjs';
let language=new URL(location.href).searchParams.get('lang')==='en'?'en':'zh-CN';
// The page names the model source that would play, so it has to ask the background which one is
// selected. PUBLIC_CONFIG carries only display fields (language, hotkey, overlay, provider name).
// Until it answers — or if it cannot — fall back to Jev, which is what the text said before.
let providerName='Jev';
function render(){const website=document.getElementById('official-site');website.href=officialWebsiteUrl(language);website.title=t(language,'officialWebsiteHint');document.documentElement.lang=language;const vars={name:providerName};document.title=t(language,'title',vars);for(const e of document.querySelectorAll('[data-i18n]'))e.textContent=t(language,e.dataset.i18n,vars);for(const [id,lang]of [['lang-zh','zh-CN'],['lang-en','en']])document.getElementById(id).setAttribute('aria-pressed',language===lang);}
for(const [id,lang]of [['lang-zh','zh-CN'],['lang-en','en']])document.getElementById(id).onclick=()=>{language=lang;history.replaceState(null,'',`?lang=${lang}`);render();};render();
try{const reply=await chrome.runtime.sendMessage({type:'PUBLIC_CONFIG'});if(reply?.ok&&reply.value?.providerName){providerName=reply.value.providerName;render();}}catch{}
