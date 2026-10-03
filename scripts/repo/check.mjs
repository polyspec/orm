import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ciServerErrors } from './ci.mjs';
import { scriptPathErrors } from './scripts.mjs';
import { COMPUTE, sections } from '../../tests/testcase.mjs';

// repository check는 CI workflow가 database 검사의 서버와 변수를 make test-servers로 주는지
// 확인하는 case 하나다.
const log = sections();
log.begin('repo', COMPUTE);

const root = new URL('../../', import.meta.url).pathname;
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
const failures = [];

const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
// CI workflow는 database 검사의 서버와 변수를 make test-servers로 준다.
failures.push(...ciServerErrors(ci, readFileSync(join(root, 'scripts/test-servers.sh'), 'utf8')));

// root npm script가 쓰는 path는 tracked file이나 directory다.
const packageScripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
failures.push(...scriptPathErrors(packageScripts, tracked));

if (failures.length > 0) {
  console.error(failures.join('\n'));
  console.error(`repository check: ${failures.length} CI server problems remain`);
  process.exit(1);
}
console.log(`repository check: ${tracked.length} tracked paths and the CI server environment inspected`);
log.end();
