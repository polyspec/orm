// model_generation coverage: orm-gen 을 커밋된 생성과 같은 인자에 --check 를 더해 실행하면 커밋된
// src/models/models.ts 가 생성 결과와 같다고 보고하고, 한 byte 를 바꾼 사본은 다르다고 보고하는지
// 확인한다. 사본은 os temp 아래의 packages/orm-npm/src/models 경로에 두어 생성 결과의 runtime
// import 가 원본과 같다.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { repositoryRoot, runCases } from './coverage_case.mjs';

const client = join(repositoryRoot, 'packages/orm-npm');

/** The orm-gen arguments of the committed generation, read from the package models script. */
async function generationArgs() {
  const pkg = JSON.parse(await readFile(join(client, 'package.json'), 'utf8'));
  const words = pkg.scripts.models.split(' ');
  assert.equal(words[0], 'node', 'the models script runs node');
  assert.ok(words.includes('--out') && words[words.indexOf('--out') + 1] === 'src/models', 'the models script writes src/models');
  return words.slice(1);
}

/** Runs orm-gen with arguments from the client directory and returns its exit code and output. */
async function ormGen(args) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, args, { cwd: client, timeout: 120_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

/** Replaces the value after --out in a copy of the arguments. */
function withOut(args, out) {
  const copy = [...args];
  copy[copy.indexOf('--out') + 1] = out;
  return copy;
}

await runCases('coverage_model_generation.mjs', {
  async model_generation_check() {
    const args = [...await generationArgs(), '--check'];
    assert.deepEqual(await ormGen(args), { code: 0, stdout: '', stderr: '' }, 'the committed models equal the generator output');
    const work = await mkdtemp(join(tmpdir(), 'orm-ts-generation-'));
    try {
      const out = join(work, 'packages/orm-npm/src/models');
      await mkdir(out, { recursive: true });
      const committed = await readFile(join(client, 'src/models/models.ts'));
      await writeFile(join(out, 'models.ts'), committed);
      assert.deepEqual(await ormGen(withOut(args, out)), { code: 0, stdout: '', stderr: '' }, 'an unchanged copy equals the generator output');
      const changed = Buffer.from(committed);
      const at = changed.indexOf('export class');
      assert.ok(at >= 0, 'models.ts declares a class');
      changed[at] = 'E'.charCodeAt(0);
      await writeFile(join(out, 'models.ts'), changed);
      const path = join(out, 'models.ts');
      assert.deepEqual(await ormGen(withOut(args, out)), { code: 1, stdout: `differs: ${path}\n`, stderr: '' }, 'a copy with one changed byte differs');
    } finally { await rm(work, { recursive: true, force: true }); }
  },
}, 300_000);
