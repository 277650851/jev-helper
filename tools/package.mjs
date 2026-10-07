import fs from 'node:fs/promises';
import {statSync} from 'node:fs';
import path from 'node:path';
import {crc32,deflateRaw} from './binary.mjs';
async function walk(root,prefix=''){const out=[];for(const e of await fs.readdir(path.join(root,prefix),{withFileTypes:true})){const name=path.posix.join(prefix,e.name);if(e.isDirectory())out.push(...await walk(root,name));else out.push(name);}return out.sort();}
const files=await walk('dist'),body=[],directory=[];let offset=0;
// ZIP stores DOS timestamps, which start in 1980 and cannot express anything earlier. Leaving the
// fields at zero yields an invalid month/day, which strict extractors warn about or rewrite.
const dosTime=at=>{const d=new Date(at);return{time:((d.getHours()&31)<<11)|((d.getMinutes()&63)<<5)|((d.getSeconds()/2)&31),date:(((d.getFullYear()-1980)&127)<<9)|(((d.getMonth()+1)&15)<<5)|(d.getDate()&31)};};
const stamp=dosTime(statSync('dist').mtimeMs);
for(const file of files){
  const name=Buffer.from(file),raw=await fs.readFile(path.join('dist',file)),crc=crc32(raw);
  // Method 8 (deflate); stored only when compression would not make the entry smaller.
  const packed=deflateRaw(raw),data=packed.length<raw.length?packed:raw,method=data===packed?8:0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(method,8);local.writeUInt16LE(stamp.time,10);local.writeUInt16LE(stamp.date,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(name.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(method,10);central.writeUInt16LE(stamp.time,12);central.writeUInt16LE(stamp.date,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
  body.push(local,name,data);directory.push(central,name);offset+=local.length+name.length+data.length;
}
const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
await fs.mkdir('artifacts',{recursive:true});
// The ZIP is named after package.json but ships dist/manifest.json; a mismatch here would put a
// version in the filename that the browser does not display. Only CI checked this before.
const {version}=JSON.parse(await fs.readFile('package.json','utf8'));
const manifest=JSON.parse(await fs.readFile('dist/manifest.json','utf8'));
if(manifest.version!==version)throw new Error(`package.json (${version}) and dist/manifest.json (${manifest.version}) versions differ`);
const out=`artifacts/werhd-jev-extension-${version}.zip`;await fs.writeFile(out,Buffer.concat([...body,central,end]));console.log(out);
