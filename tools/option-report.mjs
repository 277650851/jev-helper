// Per-option lifecycle of an autopilot match, offline, from a saved battle report.
//
//   node tools/option-report.mjs <jev-report-*.json> [--json]
//
// The counting and the rendering both live in src/report-audit.mjs so they can be tested without a file or
// a model; this entry point only reads the file and prints -- the same split as tools/audit-report.mjs, and
// for the same reason (a tool is only ever run by hand, so a broken tool stayed green in `npm test`).
//
// What it adds over tools/audit-report.mjs: that one answers "how much choice did each question leave" and
// "who decided, per group". This one answers, per OPTION KEY, which candidates are decoration -- built every
// turn, shown to the model, never picked and never executed -- and which the engine takes while the model is
// never shown them. Both are mechanism diagnoses, so a single match settles them.
import fs from 'node:fs/promises';
import { optionLifecycle, formatOptionAudit, reportMeta } from '../src/report-audit.mjs';

const file = process.argv[2];
const asJson = process.argv.includes('--json');
if (!file) { console.error('usage: node tools/option-report.mjs <jev-report-*.json> [--json]'); process.exit(1); }

const report = JSON.parse(await fs.readFile(file, 'utf8'));
const isArray = Array.isArray(report);
const entries = isArray ? report : report.entries ?? [];
const lifecycle = optionLifecycle(entries);
const truncated = !isArray && report.logTruncated === true;

if (asJson) {
  console.log(JSON.stringify({ file, truncated, ...reportMeta(isArray ? {} : report.match ?? {}), ...lifecycle }, null, 2));
} else {
  for (const line of formatOptionAudit(lifecycle, { file, truncated })) console.log(line);
}
