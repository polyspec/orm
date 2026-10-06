// push gate다. push는 checklist 항목이 `[~]`가 아닐 때만 한다(AGENTS.md): CI가 push한 tree에서 전체 suite를
// 실행하고, 그 guard(full-run.mjs)는 항목이 진행 중인 tree를 거부한다. 진행 중 항목은 guard의 activeItems가 정한다.
//
//   node scripts/check/push-gate.mjs hook          .githooks/pre-push가 실행한다. stdin은 git의 pre-push 입력이다
//   node scripts/check/push-gate.mjs commit <rev>  CI(.github/workflows/push-gate.yml)가 push한 commit에 실행한다
//   node scripts/check/push-gate.mjs hooks-check   core.hooksPath가 `.githooks`이고 hook이 실행 가능한지 본다
//
// hook은 push하는 ref마다 그 commit의 docs/checklist.md와 working tree의 docs/checklist.md를 읽고, 진행 중 항목이
// 하나라도 있으면 각 항목의 ID와 제목을 적고 거부한다(종료 상태 1). 읽을 수 없는 checklist, git 오류와 parser의
// 예외도 거부한다. commit은 그 commit의 checklist와 그 commit이 hook을 mode 100755로 추적하는지 보고, 거부 줄을
// GitHub annotation(`::error::`)과 GITHUB_STEP_SUMMARY로도 적는다.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeItems } from './full-run.mjs';
import { HOOK, hooksProblem } from './hooks.mjs';

export const CHECKLIST = 'docs/checklist.md';
const RULE = 'A push happens only when no checklist item is [~] (AGENTS.md): CI runs the full suite on the pushed tree, and its guard refuses a tree with an item in progress.';
const FIX = 'Complete each item ([o] with its changelog entry, committed), or mark it [!] with Cause and Retry when it must be bypassed; then push again.';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} exited with ${result.status}: ${result.stderr.trim()}`);
  return result.stdout;
}

const short = sha => sha.slice(0, 12);

// pushedRefs는 pre-push 입력의 줄마다 push하는 ref와 commit을 돌려준다. 지우는 ref(commit이 0)는 tree가 없다.
export function pushedRefs(input) {
  return input.split('\n').filter(Boolean).map(line => {
    const [ref, sha] = line.split(' ');
    return { ref, sha };
  }).filter(({ sha }) => !/^0+$/.test(sha));
}

// examine은 sources({where, read})의 checklist를 읽고 진행 중 항목과 읽지 못한 이유를 모은다.
function examine(sources) {
  const found = [];
  const unreadable = [];
  for (const { where, read } of sources) {
    try {
      for (const item of activeItems(read())) found.push({ where, ...item });
    } catch (error) {
      unreadable.push(`push refused: the push gate cannot read ${CHECKLIST} of ${where}: ${error.message.trim()}`);
    }
  }
  return { found, unreadable };
}

// refusal은 거부 메시지의 줄이다. 거부가 아니면 빈 배열이다.
export function refusal({ found, unreadable, problems = [] }) {
  const lines = [...unreadable, ...problems];
  if (found.length) {
    lines.push(`push refused: checklist items are in progress (${CHECKLIST}):`);
    for (const { where, id, title } of found) lines.push(`  ${where}: ${id} ${title}`);
  }
  return lines.length ? [...lines, RULE, FIX] : [];
}

// hook은 pre-push 입력의 commit과 working tree를 검사한다.
export function hook(root, input) {
  const sources = pushedRefs(input).map(({ ref, sha }) => ({ where: `${ref} ${short(sha)}`, read: () => git(root, 'show', `${sha}:${CHECKLIST}`) }));
  sources.push({ where: 'working tree', read: () => readFileSync(resolve(root, CHECKLIST), 'utf8') });
  return refusal(examine(sources));
}

// commit은 CI의 검사다: rev의 checklist와 그 commit이 추적하는 hook의 mode.
export function commit(root, rev) {
  const sha = git(root, 'rev-parse', '--verify', `${rev}^{commit}`).trim();
  const problems = [];
  const entry = git(root, 'ls-tree', sha, '--', HOOK).trim();
  const mode = entry.split(' ')[0];
  if (!entry) problems.push(`push refused: ${HOOK} is not tracked in commit ${short(sha)}; every checkout needs the pre-push hook`);
  else if (mode !== '100755') problems.push(`push refused: ${HOOK} is tracked with mode ${mode}, not 100755, in commit ${short(sha)}; git does not run it`);
  return refusal({ ...examine([{ where: `${rev} ${short(sha)}`, read: () => git(root, 'show', `${sha}:${CHECKLIST}`) }]), problems });
}

function main(args) {
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const [mode, rev] = args;
  if (mode === 'hook' && args.length === 1) {
    const lines = hook(root, readFileSync(0, 'utf8'));
    for (const line of lines) console.error(line);
    return lines.length ? 1 : 0;
  }
  if (mode === 'commit' && args.length === 2) {
    const lines = commit(root, rev);
    if (!lines.length) {
      console.log(`push-gate: commit ${rev} has no checklist item in progress and tracks ${HOOK} with mode 100755`);
      return 0;
    }
    for (const line of lines) console.log(`::error::${line}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## push-gate\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
    return 1;
  }
  if (mode === 'hooks-check' && args.length === 1) {
    const problem = hooksProblem(root);
    if (problem) {
      console.error(`hooks-check: ${problem}`);
      return 1;
    }
    console.log(`hooks-check: core.hooksPath is .githooks and ${HOOK} is executable`);
    return 0;
  }
  console.error('usage: node scripts/check/push-gate.mjs hook | commit <rev> | hooks-check');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    // gate가 결정하지 못하면 push를 허용하지 않는다.
    console.error(`push refused: the push gate failed: ${error.stack ?? error}`);
    process.exitCode = 1;
  }
}
