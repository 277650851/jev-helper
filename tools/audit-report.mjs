// Audit the QUESTION SET an autopilot match actually asked, offline, from a saved battle report.
// The counting and the rendering both live in src/report-audit.mjs so they can be tested without a file or
// a model; this entry point only reads the file and prints. That split is deliberate: when the rendering
// lived here a broken string replacement made this script unparseable while the whole test suite stayed
// green, because a tool is only ever run by hand.
//
//   node tools/audit-report.mjs <jev-report-*.json> [--json]
//
// Reading the numbers: `forced` is a question whose only non-wait option is a single key. Those are not
// judgement calls by construction -- whatever made the option legal had already been established by the
// engine -- so a high `forced` share with a high refusal rate means the model is being consulted where its
// opinion cannot help. Compare groups: on three real matches the vehicles group refused 92-97% of its
// forced questions while tactics refused 0-10%, which is a property of the questions, not of the model.
import fs from 'node:fs/promises';
import { auditReport, reportMeta, takeoversOf, formatAuditReport } from '../src/report-audit.mjs';

const file = process.argv[2];
const asJson = process.argv.includes('--json');
if (!file) { console.error('usage: node tools/audit-report.mjs <jev-report-*.json> [--json]'); process.exit(1); }

const report = JSON.parse(await fs.readFile(file, 'utf8'));
const entries = Array.isArray(report) ? report : report.entries ?? [];
const audit = auditReport(entries, reportMeta(Array.isArray(report) ? {} : report.match ?? {}));
const takeovers = takeoversOf(entries);

if (asJson) {
  console.log(JSON.stringify({ file, ...audit, takeovers }, null, 2));
} else {
  for (const line of formatAuditReport(audit, takeovers, file)) console.log(line);
}
