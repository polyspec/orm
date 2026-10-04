import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ciCheckTargetErrors, ciServerErrors } from './ci.mjs';
import { nodeVersionErrors } from './node.mjs';
import { phpVersionErrors, rustToolchainErrors } from './toolchains.mjs';
import { scriptPathErrors } from './scripts.mjs';
import { COMPUTE, sections } from '../../tests/testcase.mjs';

// repository check는 CI workflow가 database 검사의 서버와 변수를 make test-servers로 주는지,
// 검사와 workflow가 .node-version의 Node 하나로 실행하는지 확인하는 case 하나다.
const log = sections();
log.begin('repo', COMPUTE);

const root = new URL('../../', import.meta.url).pathname;
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
const failures = [];

const makefile = readFileSync(join(root, 'Makefile'), 'utf8');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
// CI workflow는 database 검사의 서버와 변수를 make test-servers로 준다.
failures.push(...ciServerErrors(ci, readFileSync(join(root, 'scripts/test-servers.sh'), 'utf8')));

// CI workflow는 로컬 make check와 같은 target(CHECK_TARGETS)을 모두 한 번씩 실행한다.
failures.push(...ciCheckTargetErrors(ci, makefile));

// root npm script가 쓰는 path는 tracked file이나 directory다.
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
failures.push(...scriptPathErrors(rootPackage.scripts ?? {}, tracked));

// 검사를 실행하는 Node는 .node-version이 선언한 version 하나이고, 모든 workflow가 그 file을 읽는다.
const nodeVersionPath = join(root, '.node-version');
const workflowDirectory = join(root, '.github/workflows');
const workflows = Object.fromEntries(readdirSync(workflowDirectory).filter(name => /\.ya?ml$/.test(name)).sort()
  .map(name => [`.github/workflows/${name}`, readFileSync(join(workflowDirectory, name), 'utf8')]));
failures.push(...nodeVersionErrors(existsSync(nodeVersionPath) ? readFileSync(nodeVersionPath, 'utf8') : '',
  rootPackage.engines?.node, workflows, process.versions.node));

// 검사를 실행하는 PHP와 Rust도 .php-version과 rust-toolchain.toml이 선언한 것 하나다. 실행 중인
// version은 repository root에서 PATH의 php와 rustc가 보고한 것이다.
const text = path => existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : '';
const reported = (program, args) => execFileSync(program, args, { cwd: root }).toString().trim();
const composer = JSON.parse(readFileSync(join(root, 'clients/php/composer.json'), 'utf8'));
const php = reported('php', ['-r', 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;']);
failures.push(...phpVersionErrors(text('.php-version'), composer.require?.php, workflows, php));
const rustc = /^rustc (\S+)/.exec(reported('rustc', ['--version']))?.[1] ?? '';
failures.push(...rustToolchainErrors(text('rust-toolchain.toml'), makefile, workflows, rustc));

if (failures.length > 0) {
  console.error(failures.join('\n'));
  console.error(`repository check: ${failures.length} CI server or toolchain version problems remain`);
  process.exit(1);
}
console.log(`repository check: ${tracked.length} tracked paths, the CI server environment, Node ${process.versions.node}, PHP ${php} and rustc ${rustc} inspected`);
log.end();
