import {build} from 'esbuild';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {iconPng} from './binary.mjs';

// Build fingerprint. A match report used to carry nothing but the manifest version, and 0.7.5 spans
// every change on this branch: jev-report-20261009-214501 was read as "old code" and then as "new
// code" in the same investigation, both times by comparing dist build times against the match clock.
// Attribution has to read a field, not reconstruct a timeline.
//
// Injected as a build-time literal rather than fetched from dist/BUILD.json: dist/ must stay
// self-contained (test/package.test.mjs fails the bundle on any `fetch(`/`eval(`/Authorization`), and
// page.mjs runs in the MAIN world where it cannot read anything the content script hands it.
const stamp = (() => {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {encoding: 'utf8'}).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}).trim() ? '-dirty' : '';
    return `${sha}${dirty}`;
  } catch {
    return 'unknown';   // not a git checkout (e.g. a dist/ copied elsewhere)
  }
})();

await fs.rm('dist',{recursive:true,force:true});await fs.mkdir('dist/icons',{recursive:true});
await fs.cp('public','dist',{recursive:true});
const inject = { BUILD_STAMP: JSON.stringify(stamp) };   // esbuild needs a JS literal, not a bare token
await Promise.all([
  build({entryPoints:{background:'src/background.mjs',popup:'src/popup.mjs',help:'src/help.mjs',dashboard:'src/dashboard.mjs'},outdir:'dist',bundle:true,format:'esm',platform:'browser',target:'chrome120',logLevel:'info',define:inject}),
  build({entryPoints:{content:'src/content.mjs',page:'src/page.mjs'},outdir:'dist',bundle:true,format:'iife',platform:'browser',target:'chrome120',logLevel:'info',define:inject}),
  ...[16,32,48,128].map(size=>fs.writeFile(`dist/icons/${size}.png`,iconPng(size))),
]);
// For a human looking at a dist/ directory. Runtime attribution reads the injected BUILD_STAMP.
await fs.writeFile('dist/BUILD.json', JSON.stringify({build: stamp, builtAt: new Date().toISOString()}, null, 2));
console.log('Load the standalone dist/ directory in Chrome or Edge. No server or game build required.');
console.log(`Build: ${stamp}`);
