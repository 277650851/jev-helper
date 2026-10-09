import {build} from 'esbuild';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {iconPng} from './binary.mjs';

// Build stamp. jev-report-20261009-214501 cost a whole analysis cycle because the report carried no
// way to tell which code produced it: the manifest version was 0.7.5 both before and after the change,
// so "did this match run the fix?" could only be answered by comparing wall-clock times, and the
// answer came out wrong twice. Attribution has to read a field, not a timeline.
const stamp = (() => {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {encoding: 'utf8'}).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}).trim() ? '-dirty' : '';
    return `${sha}${dirty}`;
  } catch {
    return 'unknown';   // not a git checkout (e.g. the offline bundle copied elsewhere)
  }
})();

await fs.rm('dist',{recursive:true,force:true});await fs.mkdir('dist/icons',{recursive:true});
await fs.cp('public','dist',{recursive:true});
// The stamp is injected as a literal rather than fetched at runtime: dist/ must stay self-contained
// (test/package.test.mjs rejects any fetch/eval/Authorization in the bundle), and page.mjs lives in
// the MAIN world where it cannot read anything the content script passes.
const inject = { BUILD_STAMP: JSON.stringify(stamp) };   // esbuild needs a JS literal, not a bare token
await Promise.all([
  build({entryPoints:{background:'src/background.mjs',popup:'src/popup.mjs',help:'src/help.mjs',dashboard:'src/dashboard.mjs'},outdir:'dist',bundle:true,format:'esm',platform:'browser',target:'chrome120',logLevel:'info',define:inject}),
  build({entryPoints:{content:'src/content.mjs',page:'src/page.mjs'},outdir:'dist',bundle:true,format:'iife',platform:'browser',target:'chrome120',logLevel:'info',define:inject}),
  ...[16,32,48,128].map(size=>fs.writeFile(`dist/icons/${size}.png`,iconPng(size))),
]);
await fs.writeFile('dist/BUILD.json', JSON.stringify({build: stamp, builtAt: new Date().toISOString()}, null, 2));
console.log(`Load the standalone dist/ directory in Chrome or Edge. No server or game build required.`);
console.log(`Build: ${stamp}`);
