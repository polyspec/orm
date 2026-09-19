// Commit subject check: every subject after the recorded baseline uses the
// "type: concise English description" format from contracts/rules.json.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const registry = JSON.parse(await readFile(path.join(root, 'contracts/rules.json'), 'utf8'));
const rule = registry.rules.find(rule => rule.id === 'git.subject-format');
if (!rule) throw new Error('contracts/rules.json: git.subject-format rule is missing');
if (!rule.baseline || !Array.isArray(rule.types) || !Number.isInteger(rule.subject_max)) {
  throw new Error('contracts/rules.json: git.subject-format needs baseline, types, and subject_max');
}

let output;
try {
  output = execFileSync('git', ['-C', root, 'log', '--format=%h%x1f%s', `${rule.baseline}..HEAD`], { encoding: 'utf8' });
} catch (error) {
  throw new Error(`git.subject-format: baseline ${rule.baseline} is not reachable: ${error.message.split('\n')[0]}`);
}

const pattern = new RegExp(`^(?:${rule.types.join('|')}): (\\S.*)$`);
const errors = [];
for (const line of output.split('\n')) {
  if (line === '') continue;
  const separator = line.indexOf('\x1f');
  const hash = line.slice(0, separator);
  const subject = line.slice(separator + 1);
  const description = subject.match(pattern)?.[1];
  if (description === undefined) errors.push(`${hash}: subject is not "${rule.types.join('|')}: concise English description": ${subject}`);
  else if (subject.length > rule.subject_max) errors.push(`${hash}: subject exceeds ${rule.subject_max} characters: ${subject}`);
  else if (subject.endsWith('.')) errors.push(`${hash}: subject ends with a period: ${subject}`);
}

if (errors.length) {
  for (const error of errors) console.error(`git.subject-format: ${error}`);
  process.exit(1);
}
console.log('git.subject-format: commit subjects passed');
