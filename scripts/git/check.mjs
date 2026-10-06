// Commit subject check: every subject of the checked range uses the
// "type(scope): Subject (#id)" format from contracts/rules.json. Merge commits
// keep the subject git writes and are not checked.
//
// Usage: node scripts/git/check.mjs                 (the subjects of the commits of ORM_GIT_RANGE, `<base>..<head>`;
//                                                     CI sets it to the pushed range or the pull request; without it the
//                                                     check reads the subject of HEAD alone)
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

// subjectRange는 검사할 commit이다. ORM_GIT_RANGE는 `<base>..<head>`이고(CI가 push나 pull request의 범위로 준다), 없거나
// 비어 있으면 HEAD 하나다: 그 subject는 commit-msg hook이 이미 검사했고, 범위를 주는 것은 CI의 event뿐이다.
export function subjectRange(env) {
  const range = env.ORM_GIT_RANGE ?? '';
  if (range === '') return { label: 'HEAD', args: ['--max-count=1', 'HEAD'] };
  if (!/^[^\s.]+\.\.[^\s.]+$/.test(range)) {
    throw new Error(`git.subject-format: ORM_GIT_RANGE is "${range}", not <base>..<head>; set it to the two commits of the range, such as origin/main..HEAD`);
  }
  return { label: range, args: [range] };
}

// rangeErrors는 range의 merge가 아닌 commit마다 subject가 규칙을 어기는 이유를 `<commit>: <reason>`으로 돌려준다.
export function rangeErrors(root, range, rule) {
  let output;
  try {
    output = execFileSync('git', ['-C', root, 'log', '--no-merges', '--format=%h%x1f%s', ...range.args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const reason = String(error.stderr || error.message).split('\n')[0];
    throw new Error(`git.subject-format: the range ${range.label} does not resolve in this checkout: ${reason}; fetch its commits or set ORM_GIT_RANGE to <base>..<head> of commits this checkout holds`);
  }
  const errors = [];
  for (const line of output.split('\n')) {
    if (line === '') continue;
    const separator = line.indexOf('\x1f');
    for (const error of subjectErrors(line.slice(separator + 1), rule)) errors.push(`${line.slice(0, separator)}: ${error}`);
  }
  return errors;
}

async function subjectRule(root) {
  const registry = JSON.parse(await readFile(path.join(root, 'contracts/rules.json'), 'utf8'));
  const rule = registry.rules.find(rule => rule.id === 'git.subject-format');
  if (!rule) throw new Error('contracts/rules.json: git.subject-format rule is missing');
  if (!Array.isArray(rule.types) || !Number.isInteger(rule.subject_max)) {
    throw new Error('contracts/rules.json: git.subject-format needs types and subject_max');
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
  // git check는 범위의 commit subject를 검사하는 case 하나다.
  const log = sections();
  log.begin('git-subjects', COMPUTE);
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const rule = await subjectRule(root);
  const range = subjectRange(process.env);
  log.step(`reading the commits of ${range.label}`);
  const errors = rangeErrors(root, range, rule);
  if (errors.length) {
    for (const error of errors) console.error(`git.subject-format: ${error}`);
    process.exit(1);
  }
  console.log(`git.subject-format: the commit subjects of ${range.label} passed`);
  log.end();
}
