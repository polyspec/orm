// The tests of scripts/typescript/node-min.mts. The script prints the bin directory of the Node release that package.json
// declares as the floor of engines.node, as mise installs it. A fetch hook loaded with --import replaces the network: the
// script must answer without calling fetch, and the hook records the call in a marker file. make ts-min-check runs the
// TypeScript tests on the Node that this script prints.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const script = join(root, 'scripts/typescript/node-min.mts');
const mise = join(root, 'var/tools/bin/mise');

// fetchHook replaces fetch: a call writes the requested URL to the marker file and fails, as an offline machine does.
const fetchHook = `
import { writeFileSync } from 'node:fs';
globalThis.fetch = async (url) => {
  writeFileSync(process.env.NODE_MIN_TEST_MARKER, String(url));
  throw new Error('network is off in this test');
};
`;

// floor is the x.y.z of engines.node ">=x.y.z" in package.json, read here independently of the script.
const floor = (): string => {
  const engines = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines?.node ?? '';
  const match = /^>=(\d+\.\d+\.\d+)$/.exec(engines);
  const floorVersion = match?.[1];
  assert.ok(floorVersion, `package.json engines.node must be ">=x.y.z", found ${JSON.stringify(engines)}`);
  return floorVersion;
};

test('node-min prints the bin of the engines floor that mise installs, and downloads nothing', () => {
  const version = floor();
  const expected = join(execFileSync(mise, ['where', `node@${version}`], { cwd: root, encoding: 'utf8' }).trim(), 'bin');
  const work = mkdtempSync(join(tmpdir(), 'node-min-test-'));
  const marker = join(work, 'fetch-called');
  try {
    const run = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(fetchHook)}`, script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        TMPDIR: work,
        // A download of Node by the script would call the fetch of the hook, which records it in the marker.
        NODE_MIN_TEST_MARKER: marker,
      },
    });
    assert.equal(run.status, 0, `node-min exited ${run.status}: ${run.stderr}`);
    assert.equal(run.stdout.trim(), expected);
    assert.equal(existsSync(marker), false, `node-min called fetch for ${existsSync(marker) ? readFileSync(marker, 'utf8') : ''}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
