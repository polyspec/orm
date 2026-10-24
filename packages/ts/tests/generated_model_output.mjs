import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Reads generated model text and returns each model's declared members. */
export async function readGeneratedModels(outputDirectory) {
  const text = await readFile(join(outputDirectory, 'models.ts'), 'utf8');
  const members = new Map();
  for (const match of text.matchAll(/export class (\w+) extends Model \{\n([\s\S]*?)\n\}\n/g)) {
    members.set(match[1], [...match[2].matchAll(/^  declare (\w+):/gm)].map(declared => declared[1]));
  }
  return {
    text,
    members(name) {
      const declared = members.get(name);
      if (declared === undefined) throw new Error(`generated model output has no class ${name}`);
      return declared;
    },
  };
}
