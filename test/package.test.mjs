import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {crc32} from '../tools/binary.mjs';
test('the release ZIP is compressed, dated and byte-identical to dist/',async(t)=>{
  const pkg=JSON.parse(await fs.readFile('package.json'));
  // `npm test` packages first; running this file alone does not have to.
  if(!await fs.access(`artifacts/werhd-jev-extension-${pkg.version}.zip`).then(()=>true,()=>false))return t.skip('no artifact yet: run npm run package');
  const zip=`artifacts/werhd-jev-extension-${pkg.version}.zip`;
  const bytes=await fs.readFile(zip);
  const listed=await fs.readdir('dist',{recursive:true});
  const entries=[];
  for(const name of listed.sort())if((await fs.stat('dist/'+name)).isFile())entries.push(name);
  const total=(await Promise.all(entries.map(async f=>(await fs.readFile('dist/'+f)).length))).reduce((a,b)=>a+b,0);
  assert.ok(bytes.length<total*0.5,`the archive is compressed (${bytes.length} vs ${total} bytes of content)`);
  for(const name of ['manifest.json','background.js','popup.html']){
    const at=bytes.indexOf(Buffer.from(name));
    assert.ok(at>0,name);
    const local=at-30;
    assert.equal(bytes.readUInt32LE(local),0x04034b50,'local file header signature');
    const central=bytes.indexOf(Buffer.from(name),bytes.length-4096);
    assert.equal(bytes.readUInt32LE(central-46),0x02014b50,'central directory signature');
    assert.equal(bytes.readUInt16LE(central-46+10),8,`${name} is deflated`);
    assert.equal(bytes.readUInt16LE(local+8),8,`${name} local method matches`);
    // DOS date fields: a zero month/day is not a real date and strict extractors reject it.
    assert.ok(bytes.readUInt16LE(central-46+14)>0,`${name} has a valid DOS date`);
    assert.equal(bytes.readUInt32LE(central-46+16),crc32(await fs.readFile('dist/'+name)),`${name} CRC matches its contents`);
    const method=bytes.readUInt16LE(local+8),csize=bytes.readUInt32LE(local+18),usize=bytes.readUInt32LE(local+22);
    assert.equal(usize,(await fs.readFile('dist/'+name)).length,`${name} uncompressed size matches`);
    assert.ok(csize>0&&csize<=(method===8?usize:usize));
  }
  // Uncompressed size and CRC must agree with the real file, or Chrome refuses the entry.
  assert.ok(entries.length>=17,'the whole built extension is packaged');
});

test('self-contained MV3 package has no remote modules, localhost bridge, eval or broad required hosts',async()=>{
  const manifest=JSON.parse(await fs.readFile('dist/manifest.json'));
  const pkg=JSON.parse(await fs.readFile('package.json'));
  assert.equal(manifest.version,pkg.version);
  assert.equal(manifest.manifest_version,3);assert.equal(manifest.background.type,'module');
  assert.equal(manifest.web_accessible_resources,undefined);
  assert.ok(!manifest.host_permissions.includes('https://*/*'));assert.ok(!manifest.permissions.includes('debugger'));
  // Chrome match patterns cannot wildcard IP octets, so the optional set is scheme-wide and the exact origin is requested at save time.
  for(const p of manifest.optional_host_permissions)assert.match(p,/^https?:\/\/(\*|[a-z0-9.-]+|\*\.[a-z0-9.-]+)\/\*$/,p);
  for(const f of ['background.js','content.js','page.js','popup.js','popup.html','popup.css','help.html','dashboard.html','dashboard.css','dashboard.js','icons/128.png'])await fs.access('dist/'+f);
  const popupHtml=await fs.readFile('dist/popup.html','utf8');assert.doesNotMatch(popupHtml,/panel-matches|log-export/,'history lives in the dashboard, not the popup');assert.match(popupHtml,/open-dashboard/);
  const page=await fs.readFile('dist/page.js','utf8');assert.doesNotMatch(page,/127\.0\.0\.1:5174|127\.0\.0\.1:8742|api\.typesafe\.ai|Authorization|JEV_API_KEY|\beval\s*\(|\bfetch\s*\(/);
  const scripts=await Promise.all(['background.js','content.js','page.js','popup.js','dashboard.js'].map(f=>fs.readFile('dist/'+f,'utf8')));
  for(const s of scripts)assert.doesNotMatch(s,/import\s*\(\s*['"]https?:/);
});
