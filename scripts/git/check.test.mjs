import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { messageSubject, subjectErrors } from './check.mjs';

const rule = { types: ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore'], subject_max: 50 };

caseTest('accepts type(scope): Subject (#id)', COMPUTE, () => {
  assert.deepEqual(subjectErrors('fix(dbspec): Let audit stand without soft_delete (#T8.1.8)', rule), []);
});

caseTest('rejects a missing type, scope or id', COMPUTE, () => {
  for (const subject of ['Pin Rust ORM dependency versions', 'fix: Pin versions (#T1)', 'fix(rust): Pin versions', 'perf(rust): Pin versions (#T1)']) {
    assert.match(subjectErrors(subject, rule).join('\n'), /type\(scope\): Subject \(#id\)/, subject);
  }
});

caseTest('rejects a lower-case subject, a final period and a subject over the limit', COMPUTE, () => {
  assert.match(subjectErrors('docs(procedure): adopt conventional commit format (#P1)', rule).join('\n'), /capital/);
  assert.match(subjectErrors('docs(schema): State the scanner scope. (#T2)', rule).join('\n'), /period/);
  assert.match(subjectErrors(`feat(dbspec): ${'A'.repeat(51)} (#T3)`, rule).join('\n'), /50 characters/);
});

caseTest('the subject of a commit message skips comment lines, and a merge has none to check', COMPUTE, () => {
  assert.equal(messageSubject('# Please enter the commit message\n\nfix(git): Refuse a long subject (#G5.49)\n\nbody\n'), 'fix(git): Refuse a long subject (#G5.49)');
  assert.equal(messageSubject("Merge branch 'x'\n"), null);
});

// commit-msg case(G5.49)는 이 checkout의 `.githooks`를 core.hooksPath로 둔 임시 repository에서 실제로 커밋한다. 50자를
// 넘는 subject의 커밋은 규칙과 길이를 적고 거부되고, 규칙에 맞는 커밋은 받아들여진다. make는 parse 때 core.hooksPath를
// `.githooks`로 둔다.
caseTest('a commit whose subject breaks the rule is refused by the commit-msg hook that make installs', PROCESS, () => {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'commit-msg-')));
  try {
    const git = (...args) => spawnSync('git', ['-C', base, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'core.hooksPath', join(repo, '.githooks'));
    writeFileSync(join(base, 'file.txt'), 'x\n');
    git('add', 'file.txt');
    const commit = subject => git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', subject);
    const long = commit("fix(build): Build Rust into the target directory of each checkout (#G5.46)");
    assert.notEqual(long.status, 0, 'a subject of 53 characters was committed');
    assert.match(long.stderr, /git\.subject-format: subject exceeds 50 characters: fix\(build\): Build Rust into the target directory of each checkout \(#G5\.46\) \(contracts\/rules\.json; the commit is refused\)/);
    assert.equal(git('rev-parse', '--verify', '-q', 'HEAD').status, 1, 'the refused commit exists');
    const short = commit("fix(build): Build Rust in each checkout's own target (#G5.46)");
    assert.equal(short.status, 0, short.stderr);
    // make은 parse 때 checkout의 core.hooksPath를 .githooks로 둔다.
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'hooks-path-')));
    try {
      spawnSync('git', ['-C', other, 'init', '-q']);
      const make = spawnSync('make', ['-n', '--no-print-directory', '-f', join(repo, 'Makefile'), '-C', other, 'version-check'], { encoding: 'utf8' });
      assert.equal(spawnSync('git', ['-C', other, 'config', 'core.hooksPath'], { encoding: 'utf8' }).stdout.trim(), '.githooks', make.stderr);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
