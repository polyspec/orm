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
//   commit-items     the commit changes the state of at most one item of the trackers of config/checklist.json; a row
//                    that the commit adds is not a change, so a commit may add items and sub-items
//   commit-changelog a commit that moves an item to the `done` state of its tracker also changes the `changelog` of the
//                    configuration, its path and its translation (only when config/commits.json declares a changelog)
//
//   node scripts/kit/check-commits.mjs [--range <base>..<head>]   the messages of the commits of the range (default: HEAD)
//   node scripts/kit/check-commits.mjs --message <file>           the message being committed (the commit-msg hook)
//
// A commit of a range is compared with its parent; the message being committed, with the index against HEAD. The item rules
// apply when config/checklist.json exists. A merge commit keeps the message that Git writes and is not checked. Each finding is one line
// `<commit>: <rule>: <message>`; the command exits with status 1 when there is one. The pre-push hook (push-gate.mjs) reads the
// same findings of the commits that a push sends, through `logMessages` and `findingLines`.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isMain, ROOT } from './paths.mjs';
import { loadConfig, readChecklist, CONFIG as CHECKLIST } from './checklist.mjs';
import { readJson } from './files.mjs';
import { git, gitResult } from './git.mjs';

export const CONFIG = 'config/commits.json';

/** The commit rules of the checkout `root`; throws when config/commits.json does not exist. */
export function loadCommitRules(root) {
  if (!existsSync(path.join(root, CONFIG))) throw new Error(`${CONFIG} does not exist; declare the commit rules there (scripts/kit/schema/commits.schema.json)`);
  return readJson(root, CONFIG);
}

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

// The text of `file` at the revision `rev` (`:` alone is the index); empty when the revision has no such file.
const fileAt = (root, rev, file) => {
  const shown = gitResult(root, 'show', `${rev}:${file}`);
  return shown.status === 0 ? shown.stdout : '';
};

/**
 * The item findings of one change as `{ rule, message }`: `before` and `after` read a tracker file at the two sides of the
 * change, `changed` holds the paths that the change touches.
 */
export function itemFindings(root, config, { before, after, changed }) {
  if (!existsSync(path.join(root, CHECKLIST))) return [];
  const changes = [];
  for (const tracker of loadConfig(root).trackers) {
    const states = text => new Map(readChecklist(text, tracker).items.map(item => [item.id, item.state]));
    const old = states(before(tracker.path));
    for (const [id, state] of states(after(tracker.path))) {
      if (old.has(id) && old.get(id) !== state) changes.push({ id, from: old.get(id), to: state, tracker });
    }
  }
  const found = [];
  if (changes.length > 1) {
    const listed = changes.map(change => `${change.id} ${change.from} → ${change.to}`).join(', ');
    found.push({ rule: 'commit-items', message: `the commit changes the state of ${changes.length} items (${listed}); change one item per commit` });
  }
  const changelog = config.changelog ? [config.changelog.path, ...(config.changelog.translation ? [config.changelog.translation] : [])] : [];
  for (const change of changes.filter(entry => entry.tracker.done !== undefined && entry.to === entry.tracker.done)) {
    for (const file of changelog.filter(entry => !changed.includes(entry))) {
      found.push({ rule: 'commit-changelog', message: `the commit moves ${change.id} to ${change.to} in ${change.tracker.path} but does not change ${file}; record the item in the changelog of both languages` });
    }
  }
  return found;
}

/** The item findings of the commit `id` against its parent; a root commit is compared with an empty tree. */
const commitItemFindings = (root, config, id) => {
  const parent = gitResult(root, 'rev-parse', '--verify', '--quiet', `${id}^`).status === 0 ? `${id}^` : null;
  return itemFindings(root, config, {
    before: file => (parent ? fileAt(root, parent, file) : ''),
    after: file => fileAt(root, id, file),
    changed: git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', '--root', id).split('\n').filter(Boolean),
  });
};

/** The item findings of the change being committed: the index against HEAD. */
export function indexItemFindings(root, config) {
  const head = gitResult(root, 'rev-parse', '--verify', '--quiet', 'HEAD').status === 0;
  return itemFindings(root, config, {
    before: file => (head ? fileAt(root, 'HEAD', file) : ''),
    after: file => fileAt(root, '', file),
    changed: git(root, 'diff', '--cached', '--name-only').split('\n').filter(Boolean),
  });
}

/** The message of a commit-msg file: without the comment lines that Git removes; null for a merge commit. */
export function fileMessage(text) {
  const message = text.split('\n').filter(line => !line.startsWith('#')).join('\n').replace(/^\n+/, '');
  return /^Merge /.test(message) ? null : message;
}

/**
 * The commits that `git log` selects with `args` in `root`, without merge commits, as `{ id, message }`; `label` names the
 * selection in the failure.
 */
export function logMessages(root, args, label) {
  let output;
  try {
    output = git(root, 'log', '--no-merges', '--format=%h%x1f%B%x1e', ...args);
  } catch (error) {
    throw new Error(`the range ${label} does not resolve in this checkout: ${error.message.split('\n')[0]}; fetch its commits or give a range of commits that this checkout holds`);
  }
  return output.split('\x1e').map(entry => entry.replace(/^\n/, '')).filter(Boolean).map((entry) => {
    const separator = entry.indexOf('\x1f');
    return { id: entry.slice(0, separator), message: entry.slice(separator + 1) };
  });
}

/** The commits of `range` (`<base>..<head>`, or `HEAD` alone) in `root`, without merge commits, as `{ id, message }`. */
export function rangeMessages(root, range) {
  if (range !== 'HEAD' && !/^[^\s.]+\.\.[^\s.]+$/.test(range)) {
    throw new Error(`the range "${range}" is not <base>..<head>; give the two commits of the range, such as origin/main..HEAD`);
  }
  return logMessages(root, range === 'HEAD' ? ['--max-count=1', 'HEAD'] : [range], range);
}

/** The findings of the commits `commits` (from `logMessages`) as lines `<commit>: <rule>: <message>`. */
export function findingLines(root, commits, config) {
  return commits.flatMap(({ id, message }) => [...messageFindings(message, config), ...commitItemFindings(root, config, id)].map(found => `${id}: ${found.rule}: ${found.message}`));
}

/** The findings of the commits of `range` as lines `<commit>: <rule>: <message>`. */
export function rangeFindings(root, range, config) {
  return findingLines(root, rangeMessages(root, range), config);
}

if (isMain(import.meta.url)) {
  const root = ROOT;
  const { values } = parseArgs({ options: { range: { type: 'string' }, message: { type: 'string' } } });
  let findings;
  let label;
  try {
    const config = loadCommitRules(root);
    if (values.message !== undefined) {
      const message = fileMessage(readFileSync(values.message, 'utf8'));
      label = 'the message being committed';
      findings = message === null ? [] : [...messageFindings(message, config), ...indexItemFindings(root, config)].map(found => `${found.rule}: ${found.message}`);
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
