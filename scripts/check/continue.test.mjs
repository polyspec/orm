// 전체 suite의 target 안에서 실패한 명령 뒤에도 독립된 다음 명령이 실행되는지 검사한다(G5.38-3). 각 case는
// 실제 script를 실행하되 PATH의 앞에 둔 가짜 php와 node가 자기 인자를 log에 적고 첫 test에서 실패한다. 실제 test와
// database는 실행하지 않는다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest, PROCESS } from '../../tests/testcase.mjs';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// fake는 program마다 인자를 log에 적고, 인자가 failing을 담으면 출력 한 줄과 함께 3으로 끝나는 가짜 program을 둔다.
function fake(programs, failing) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'continue-')));
  mkdirSync(join(base, 'bin'));
  const log = join(base, 'ran.log');
  for (const program of programs)
    writeFileSync(join(base, 'bin', program), `#!/bin/sh\necho "${program} $*" >> ${log}\ncase "$*" in *${failing}*) echo 'FAIL ${failing}: expected 1 row, actual 0'; exit 3;; esac\n`, { mode: 0o755 });
  return {
    base,
    run: (args, env = {}) => spawnSync('sh', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${join(base, 'bin')}:${process.env.PATH}`, ...env } }),
    ran: () => readFileSync(log, 'utf8').trim().split('\n'),
  };
}

caseTest('the PHP lane of client-db-test runs every test after a failed one and names the failures', PROCESS, () => {
  const f = fake(['php'], 'model_test');
  try {
    const result = f.run(['scripts/client-db-test.sh', '--lane', 'php'], { ORM_RUST_TEST_FEATURES: 'none' });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const ran = f.ran();
    assert.equal(ran.length, 11, ran.join('\n'));
    assert.deepEqual([ran[0], ran.at(-1)], ['php clients/php/tests/model_test.php', 'php clients/php/tests/mysql_tls.php']);
    assert.match(result.stderr, /client-db-test: the php lane failed:\n {2}php clients\/php\/tests\/model_test\.php \(exit 3\)/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

caseTest('the TypeScript SQLite tests run every test after a failed one and name the failures', PROCESS, () => {
  const f = fake(['node'], 'model.mjs');
  try {
    const result = f.run(['scripts/typescript/sqlite-test.sh']);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const ran = f.ran();
    assert.equal(ran.length, 10, ran.join('\n'));
    assert.deepEqual([ran[1], ran.at(-1)], ['node clients/typescript/tests/model.mjs', 'node clients/typescript/tests/mysql_tls.mjs']);
    assert.match(result.stderr, /sqlite-test: failed:\n {2}node clients\/typescript\/tests\/model\.mjs \(exit 3\)/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
