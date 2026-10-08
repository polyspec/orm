#!/usr/bin/env node
// Checks commit messages against config/commits.json (`make commits-check`):
//
//   commit-subject   the first line is `type(scope): Subject (#id)` with a type of the configuration, a scope of lower case
//                    letters, digits and hyphens, and an id of letters, digits, dots and hyphens
//   commit-capital   the Subject starts with a capital letter
//   commit-period    the Subject does not end with a period
//   commit-length    the Subject has at most `subjectMax` characters
//   commit-blank     a body follows the subject after a blank line
//   commit-width     a line of the body has at most `bodyMax` characters
//
//   node scripts/kit/check-commits.mjs [--range <base>..<head>]   the messages of the commits of the range (default: HEAD)
//   node scripts/kit/check-commits.mjs --message <file>           the message being committed (the commit-msg hook)
//
// A merge commit keeps the message that Git writes and is not checked. Each finding is one line
// `<commit>: <rule>: <message>`; the command exits with status 1 when there is one.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isMain, ROOT } from './paths.mjs';
import { readJson } from './files.mjs';
import { git } from './git.mjs';

export const CONFIG = 'config/commits.json';

/** The findings of a commit `message` as `{ rule, message }`. */
export function messageFindings(message, config) {
  const lines = message.replace(/\s+$/, '').split('\n');
  const subject = lines[0] ?? '';
  const found = [];
  const pattern = new RegExp(`^(?:${config.types.join('|')})\\([a-z0-9-]+\\): (\\S.*) \\(#[A-Za-z0-9][A-Za-z0-9.-]*\\)$`);
  const description = pattern.exec(subject)?.[1];
  if (description === undefined) {
    found.push({ rule: 'commit-subject', message: `the subject is ${JSON.stringify(subject)}; expected "type(scope): Subject (#id)" with a type of ${config.types.join(', ')}` });
  } else {
    if (!/^[A-Z]/.test(description)) found.push({ rule: 'commit-capital', message: `the Subject ${JSON.stringify(description)} does not start with a capital letter` });
    if (description.endsWith('.')) found.push({ rule: 'commit-period', message: `the Subject ${JSON.stringify(description)} ends with a period; remove it` });
    if (description.length > config.subjectMax) found.push({ rule: 'commit-length', message: `the Subject has ${description.length} characters; expected at most ${config.subjectMax}` });
  }
  if (lines.length > 1 && lines[1] !== '') found.push({ rule: 'commit-blank', message: 'the line after the subject is not blank; leave a blank line before the body' });
  lines.slice(2).forEach((line, index) => {
    if (line.length > config.bodyMax && /\s/.test(line.trim())) {
      found.push({ rule: 'commit-width', message: `line ${index + 3} of the message has ${line.length} characters; expected at most ${config.bodyMax}; wrap the body` });
    }
  });
  return found;
}

/** The message of a commit-msg file: without the comment lines that Git removes; null for a merge commit. */
export function fileMessage(text) {
  const message = text.split('\n').filter(line => !line.startsWith('#')).join('\n').replace(/^\n+/, '');
  return /^Merge /.test(message) ? null : message;
}

/** The commits of `range` (`<base>..<head>`, or `HEAD` alone) in `root`, without merge commits, as `{ id, message }`. */
export function rangeMessages(root, range) {
  if (range !== 'HEAD' && !/^[^\s.]+\.\.[^\s.]+$/.test(range)) {
    throw new Error(`the range "${range}" is not <base>..<head>; give the two commits of the range, such as origin/main..HEAD`);
  }
  const args = range === 'HEAD' ? ['--max-count=1', 'HEAD'] : [range];
  let output;
  try {
    output = git(root, 'log', '--no-merges', '--format=%h%x1f%B%x1e', ...args);
  } catch (error) {
    throw new Error(`the range ${range} does not resolve in this checkout: ${error.message.split('\n')[0]}; fetch its commits or give a range of commits that this checkout holds`);
  }
  return output.split('\x1e').map(entry => entry.replace(/^\n/, '')).filter(Boolean).map((entry) => {
    const separator = entry.indexOf('\x1f');
    return { id: entry.slice(0, separator), message: entry.slice(separator + 1) };
  });
}

/** The findings of the commits of `range` as lines `<commit>: <rule>: <message>`. */
export function rangeFindings(root, range, config) {
  return rangeMessages(root, range).flatMap(({ id, message }) => messageFindings(message, config).map(found => `${id}: ${found.rule}: ${found.message}`));
}

if (isMain(import.meta.url)) {
  const root = ROOT;
  const { values } = parseArgs({ options: { range: { type: 'string' }, message: { type: 'string' } } });
  if (!existsSync(path.join(root, CONFIG))) {
    console.error(`[check-commits] ${CONFIG} does not exist; declare the commit rules there (scripts/kit/schema/commits.schema.json)`);
    process.exit(1);
  }
  const config = readJson(root, CONFIG);
  let findings;
  let label;
  try {
    if (values.message !== undefined) {
      const message = fileMessage(readFileSync(values.message, 'utf8'));
      label = 'the message being committed';
      findings = message === null ? [] : messageFindings(message, config).map(found => `${found.rule}: ${found.message}`);
    } else {
      label = `the commits of ${values.range ?? 'HEAD'}`;
      console.log(`[check-commits] reading ${label}`);
      findings = rangeFindings(root, values.range ?? 'HEAD', config);
    }
  } catch (error) {
    console.error(`[check-commits] ${error.message}`);
    process.exit(1);
  }
  for (const line of findings) console.error(`[check-commits] ${line}`);
  if (findings.length) {
    console.error(`[check-commits] ${findings.length} findings in ${label} (${CONFIG})`);
    process.exit(1);
  }
  console.log(`[check-commits] ${label} passed`);
}
