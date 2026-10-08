#!/usr/bin/env node
// Writes the review record of tests/kit/fixture with the review tool, the stub registries of FIXTURE_REGISTRY and a stub
// cargo-audit and a stub govulncheck that find nothing, in a copy of the fixture, and copies the record back, so the committed record is the
// output of the tool (`make kit-fixture-record`). A second run changes only the time.
//
//   node tests/kit/record-fixture.mjs
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureCheckout, installCargoAuditStub, installGovulncheckStub, review } from './checkout.mjs';
import { FIXTURE_REGISTRY, stubRegistries } from './registry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cleanups = [];
const t = { after: callback => cleanups.push(callback) };
try {
  const root = fixtureCheckout(t);
  installCargoAuditStub(root);
  installGovulncheckStub(root);
  const stub = stubRegistries(t);
  stub.registry(FIXTURE_REGISTRY);
  const run = review(root, ['--record'], stub.env);
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  if (run.status === 0) copyFileSync(path.join(root, 'config/dependency-review.json'), path.join(here, 'fixture/config/dependency-review.json'));
  process.exitCode = run.status ?? 1;
} finally {
  for (const callback of cleanups) callback();
}
