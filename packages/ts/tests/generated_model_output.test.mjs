import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readGeneratedModels } from './generated_model_output.mjs';

test('reads generated model text and declared members by class', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orm-generated-model-output-'));
  try {
    const text = [
      'export class User extends Model {',
      '  declare id: number;',
      '  declare name: string;',
      '}',
      '',
      'export class Post extends Model {',
      '  declare title: string;',
      '}',
      '',
      'export class Empty extends Model {',
      '  static entity = {};',
      '}',
      '',
    ].join('\n');
    await writeFile(join(directory, 'models.ts'), text);

    const output = await readGeneratedModels(directory);
    assert.equal(output.text, text);
    assert.deepEqual(output.members('User'), ['id', 'name']);
    assert.deepEqual(output.members('Post'), ['title']);
    assert.deepEqual(output.members('Empty'), []);
    assert.throws(() => output.members('Missing'), /generated model output has no class Missing/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
