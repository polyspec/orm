#!/usr/bin/env node
// Sets the exact pin of a Python requirement in a pyproject.toml (`make dependency-review UPDATE=1` runs it for each
// PyPI dependency that has a newer stable release):
//
//   node scripts/pin-python-dependency.mjs <manifest> <package> <version>
//
// It replaces `"<package>==<old>"` with `"<package>==<version>"` in every array of the file and writes the file through
// a temporary file and a rename. A package that the file does not pin exactly fails the command.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isMain } from './paths.mjs';
import { writeAtomic } from './files.mjs';

/** The text of the file with the pin of `name` set to `version`; the number of replacements is returned with it. */
export function pinPythonRequirement(text, name, version) {
  const pattern = new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}==\\d+(?:\\.\\d+)*"`, 'g');
  const matches = text.match(pattern) ?? [];
  if (matches.length === 0) throw new Error(`no exact pin of ${name} in the file`);
  return { text: text.replace(pattern, `"${name}==${version}"`), count: matches.length };
}

if (isMain(import.meta.url)) {
  const [manifest, name, version] = process.argv.slice(2);
  if (!manifest || !name || !version) {
    console.error('usage: node scripts/pin-python-dependency.mjs <manifest> <package> <version>');
    process.exit(2);
  }
  const file = path.resolve(manifest);
  const { text } = pinPythonRequirement(readFileSync(file, 'utf8'), name, version);
  writeAtomic(file, text);
  console.log(`[pin-python-dependency] ${manifest}: ${name}==${version}`);
}
