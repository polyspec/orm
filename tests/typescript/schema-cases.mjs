// Shared schema tool cases: the TypeScript build, DDL, diff, and plan outputs
// have the digests recorded in tests/schema/cases.json
// (go run ./tests/schema/record).
//
// Usage: node tests/typescript/schema-cases.mjs (after npm run typescript:build)
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { renderDDL, ddlErrorText } from '../../clients/typescript/dist/engine/ddl.js';
import { buildManifest, manifestText } from '../../clients/typescript/dist/schema/build.js';
import { parseDiagram } from '../../clients/typescript/dist/schema/mermaid.js';
import { loadedOf, renderDiff } from '../../clients/typescript/dist/tools/diff.js';
import { buildMigrationPlan } from '../../clients/typescript/dist/tools/plan.js';

const file = JSON.parse(await readFile(new URL('../schema/cases.json', import.meta.url), 'utf8'));

let failures = 0;
let checks = 0;

function digest(run, errorText = error => error.message) {
  try {
    return { sha256: createHash('sha256').update(run()).digest('hex') };
  } catch (error) {
    return { error: errorText(error) };
  }
}

function same(label, want, got) {
  checks++;
  if ((want.sha256 ?? '') === (got.sha256 ?? '') && (want.error ?? '') === (got.error ?? '')) return;
  failures++;
  console.error(`FAIL: ${label}\n  want: ${JSON.stringify(want)}\n  got:  ${JSON.stringify(got)}`);
}

const manifests = new Map();
for (const c of file.cases) {
  let manifest;
  const got = digest(() => {
    manifest = buildManifest([parseDiagram(c.mmd)]);
    return manifestText(manifest);
  });
  same(`build ${c.name}`, c.manifest, got);
  if (!manifest) continue;
  manifests.set(c.name, manifest);
  for (const [dialect, want] of Object.entries(c.ddl ?? {})) {
    same(`ddl ${dialect} ${c.name}`, want, digest(() => renderDDL(loadedOf(manifest), dialect), ddlErrorText));
  }
}

function pair(entry) {
  const from = manifests.get(entry.from);
  const to = manifests.get(entry.to);
  if (!from || !to) throw new Error(`missing manifest for ${entry.from} -> ${entry.to}`);
  return [from, to];
}

for (const d of file.diffs) {
  const [from, to] = pair(d);
  same(`diff ${d.dialect} allow=${d.allow_destructive} ${d.from} -> ${d.to}`, d, digest(() => renderDiff(from, to, d.dialect, d.allow_destructive)));
}

for (const p of file.plans) {
  const [from, to] = pair(p);
  same(`plan ${p.dialect} ${p.from} -> ${p.to}`, p, digest(() => buildMigrationPlan(from, to, p.dialect, file.plan_id, file.plan_name)));
}

if (failures > 0) {
  console.error(`typescript schema cases: ${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`typescript schema cases passed (${file.cases.length} cases, ${file.diffs.length} diffs, ${file.plans.length} plans; ${checks} checks)`);
