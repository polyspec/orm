// Commit subject check: every subject after the recorded baseline uses the
// "type(scope): Subject (#id)" format from contracts/rules.json. Merge commits
// keep the subject git writes and are not checked.
//
// Usage: node scripts/git/check.mjs                 (the subjects of git log after the baseline)
//        node scripts/git/check.mjs --message <file> (the subject of a message being committed;
//                                                     the commit-msg hook .githooks/commit-msg runs this)
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path, { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPUTE, sections } from '../../tests/testcase.mjs';

// subjectErrors returns the reasons a subject breaks the rule, or none.
export function subjectErrors(subject, rule) {
  const pattern = new RegExp(`^(?:${rule.types.join('|')})\\([a-z0-9-]+\\): (\\S.*) \\(#[A-Za-z0-9.-]+\\)$`);
  const description = subject.match(pattern)?.[1];
  if (description === undefined) return [`subject is not "type(scope): Subject (#id)" with a type of ${rule.types.join('|')}: ${subject}`];
  const errors = [];
  if (!/^[A-Z]/.test(description)) errors.push(`subject does not start with a capital letter: ${subject}`);
  if (description.endsWith('.')) errors.push(`subject ends with a period: ${subject}`);
  if (description.length > rule.subject_max) errors.push(`subject exceeds ${rule.subject_max} characters: ${subject}`);
  return errors;
}

// messageSubject는 commit message file의 subject다: git이 지우는 `#` 주석 줄을 빼고 처음으로 비어 있지 않은 줄이다.
// merge commit은 git이 쓰는 subject를 두므로 검사하지 않고 null을 돌려준다.
export function messageSubject(text) {
  const subject = text.split('\n').find(line => !line.startsWith('#') && line.trim() !== '') ?? '';
  return /^Merge /.test(subject) ? null : subject;
}

async function subjectRule(root) {
  const registry = JSON.parse(await readFile(path.join(root, 'contracts/rules.json'), 'utf8'));
  const rule = registry.rules.find(rule => rule.id === 'git.subject-format');
  if (!rule) throw new Error('contracts/rules.json: git.subject-format rule is missing');
  if (!rule.baseline || !Array.isArray(rule.types) || !Number.isInteger(rule.subject_max)) {
    throw new Error('contracts/rules.json: git.subject-format needs baseline, types, and subject_max');
  }
  return rule;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--message') {
  // commit-msg hook: 커밋하려는 message의 subject를 검사하고, 규칙을 어기면 그 이유를 적고 커밋을 거부한다.
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const rule = await subjectRule(root);
  const subject = messageSubject(await readFile(process.argv[3], 'utf8'));
  const errors = subject === null ? [] : subjectErrors(subject, rule);
  if (errors.length) {
    for (const error of errors) console.error(`git.subject-format: ${error} (contracts/rules.json; the commit is refused)`);
    process.exit(1);
  }
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // git check는 git log를 읽어 commit subject를 검사하는 case 하나다.
  const log = sections();
  log.begin('git-subjects', COMPUTE);
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const rule = await subjectRule(root);

  let output;
  try {
    output = execFileSync('git', ['-C', root, 'log', '--no-merges', '--format=%h%x1f%s', `${rule.baseline}..HEAD`], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`git.subject-format: baseline ${rule.baseline} is not reachable: ${error.message.split('\n')[0]}`);
  }

  const errors = [];
  for (const line of output.split('\n')) {
    if (line === '') continue;
    const separator = line.indexOf('\x1f');
    for (const error of subjectErrors(line.slice(separator + 1), rule)) errors.push(`${line.slice(0, separator)}: ${error}`);
  }

  if (errors.length) {
    for (const error of errors) console.error(`git.subject-format: ${error}`);
    process.exit(1);
  }
  console.log('git.subject-format: commit subjects passed');
  log.end();
}
