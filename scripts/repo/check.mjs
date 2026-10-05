import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTargets, ciCheckTargetErrors, ciDuplicateCommandErrors, ciLeaseErrors, ciRerunErrors, ciServerErrors, expand, featureCommands, makeVariables, runnerErrors, stepTimeoutErrors, workflowSteps } from './ci.mjs';
import { nodeVersionErrors } from './node.mjs';
import { binExeErrors, manifestDirErrors, runFile, targetPathErrors } from './target.mjs';
import { connectProbeErrors, runtimeSource } from './probes.mjs';
import { phpVersionErrors, rustToolchainErrors } from './toolchains.mjs';
import { scriptPathErrors, toolingLanguageErrors } from './scripts.mjs';
import { goCargoErrors, goRunErrors, goTestCaseErrors, longDeadlineErrors, makeRecipes, runtimePathErrors, sharedTargetErrors, typescriptHolderErrors, typescriptReaderErrors, unleasedCargoErrors, nodeTestErrors, rawGoTestErrors, reachedScripts, repeatedGenerateErrors, reportingScriptErrors, rustTestCaseErrors, segments, unbuiltCargoTestErrors, unwrappedToolErrors } from './testcases.mjs';
import { checkInputErrors } from '../features/owners.mjs';
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
// make check의 feature-check가 실행하는 검증 명령을 CI가 따로 다시 실행하지 않는다.
const features = JSON.parse(readFileSync(join(root, 'contracts/features.json'), 'utf8'));
failures.push(...ciDuplicateCommandErrors(ci, makefile, featureCommands(features)));
// make check를 실행하는 CI는 그 밖에서 test runner를 다시 실행하지 않는다(runner의 정체로 판단).
failures.push(...ciRerunErrors(ci, makefile));

// root npm script가 쓰는 path는 tracked file이나 directory다.
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
failures.push(...scriptPathErrors(rootPackage.scripts ?? {}, tracked));
// repository의 도구는 Go, PHP, Rust, TypeScript(와 shell)로 쓴다.
failures.push(...toolingLanguageErrors(tracked));

// 검사를 실행하는 Node는 .node-version이 선언한 version 하나이고, 모든 workflow가 그 file을 읽는다.
const nodeVersionPath = join(root, '.node-version');
const workflowDirectory = join(root, '.github/workflows');
const workflows = Object.fromEntries(readdirSync(workflowDirectory).filter(name => /\.ya?ml$/.test(name)).sort()
  .map(name => [`.github/workflows/${name}`, readFileSync(join(workflowDirectory, name), 'utf8')]));
// CHECK_TARGETS의 모든 target은 contracts/check-inputs.json에 scope를 선언하고, owner target은 make
// owner-check가 고를 입력도 선언한다.
const checkInputs = JSON.parse(readFileSync(join(root, 'contracts/check-inputs.json'), 'utf8')).targets;
failures.push(...checkInputErrors(checkInputs, checkTargets(makefile), tracked));
// cargo가 만든 program의 경로는 CARGO_TARGET_DIR에서 얻는다.
failures.push(...targetPathErrors(Object.fromEntries(tracked.filter(runFile).map(path => [path, readFileSync(join(root, path), 'utf8')]))));
failures.push(...manifestDirErrors(Object.fromEntries(tracked.filter(path => path.endsWith('.rs')).map(path => [path, readFileSync(join(root, path), 'utf8')]))));
failures.push(...binExeErrors(Object.fromEntries(tracked.filter(path => path.endsWith('.rs')).map(path => [path, readFileSync(join(root, path), 'utf8')]))));
// 연결은 server에 SQLite version이나 연결 여부를 묻는 statement를 보내지 않는다.
failures.push(...connectProbeErrors(Object.fromEntries(tracked.filter(runtimeSource).map(path => [path, readFileSync(join(root, path), 'utf8')]))));
// 모든 test는 자기 기한 아래 case로 보고한다(scripts/repo/testcases.mjs).
const trackedText = paths => Object.fromEntries(paths.map(path => [path, readFileSync(join(root, path), 'utf8')]));
failures.push(...nodeTestErrors(trackedText(tracked.filter(path => /\.(?:mjs|js)$/.test(path) && !path.startsWith('docs/')))));
failures.push(...goTestCaseErrors(trackedText(tracked.filter(path => path.endsWith('_test.go')))));
failures.push(...rustTestCaseErrors(trackedText(tracked.filter(path => path.endsWith('.rs')))));
// Makefile, contracts/features.json, scripts/의 shell script와 root package.json이 실행하는 PHP와
// TypeScript test도 공유 case 보고를 쓴다.
const trackedSet = new Set(tracked);
const runCommands = [
  ...makefile.split('\n').filter(line => line.startsWith('\t')).map(line => ({ source: 'Makefile', command: line.slice(1) })),
  ...featureCommands(features).map(command => ({ source: 'contracts/features.json', command })),
  ...tracked.filter(path => /^scripts\/.*\.sh$/.test(path)).flatMap(path => readFileSync(join(root, path), 'utf8').split('\n').map(command => ({ source: path, command }))),
  ...Object.values(rootPackage.scripts ?? {}).map(command => ({ source: 'package.json', command })),
];
failures.push(...reportingScriptErrors(runCommands, path => trackedSet.has(path) ? readFileSync(join(root, path), 'utf8') : undefined));
// build와 lint 도구(tsc, go generate, go vet, go build, cargo build)는 장기 작업이므로 tests/run-long.mjs
// 아래에서 단계 로그와 함께 기한 없이 실행한다.
const featureUnits = [...features.features.flatMap(feature => feature.verification.filter(check => (check.cwd ?? '.') === '.')
  .map(check => ({ name: `contracts/features.json ${feature.id}/${check.id}`, commands: [check.command] }))),
  ...(features.helpers ?? []).map(helper => ({ name: `contracts/features.json helper ${helper.id}`, commands: [helper.command] }))];
failures.push(...unwrappedToolErrors(featureUnits));
// cargo test 실행 앞에는 같은 인자의 `cargo test --no-run` build가 RUN_LONG 아래에서 기한 없이 있다.
// Makefile recipe, 검증 명령, root package.json script, 그리고 그 명령이 run-long 밖에서 실행하는
// scripts/의 shell script를 본다.
const readTracked = path => trackedSet.has(path) ? readFileSync(join(root, path), 'utf8') : undefined;
const recipeUnits = makeRecipes(makefile);
const scriptUnits = reachedScripts(runCommands, readTracked);
const allPackageUnits = Object.entries(rootPackage.scripts ?? {}).map(([name, command]) => ({ name: `package.json ${name}`, commands: [command] }));
failures.push(...unbuiltCargoTestErrors([...recipeUnits, ...featureUnits, ...allPackageUnits, ...scriptUnits]));
// Makefile recipe, 명령 여럿인 root package.json script(명령 하나인 script는 도구의 정의이고 그
// 호출을 본다), run-long 밖의 shell script도 build 도구를 run-long 아래에서 기한 없이 실행한다.
const packageUnits = allPackageUnits.filter(unit => segments(unit.commands[0]).length > 1);
failures.push(...unwrappedToolErrors([...recipeUnits, ...packageUnits, ...scriptUnits]));
// go test는 tests/go-test.mjs(기한 없는 build 뒤 실행)나 RUN_LONG 아래에서 실행한다.
const variables = makeVariables(makefile);
const expandedRecipes = recipeUnits.map(unit => ({ name: unit.name, commands: unit.commands.map(command => expand(command, variables)) }));
failures.push(...rawGoTestErrors([...expandedRecipes, ...featureUnits, ...scriptUnits]));
// check의 명령(Makefile recipe, 검증 명령, package.json script, run-long 아래의 것까지 scripts/의 shell
// script)은 장기 작업에 기한을 두지 않는다. 기한은 test case 안에만 있다.
const everyScriptUnit = reachedScripts(runCommands, readTracked, { throughLong: true });
failures.push(...longDeadlineErrors([...expandedRecipes, ...featureUnits, ...allPackageUnits, ...everyScriptUnit]));
// go run의 build는 단계 로그가 없으므로 tests/go-run.mjs로 실행한다. workflow의 step도 본다.
failures.push(...goRunErrors([...expandedRecipes, ...featureUnits, ...allPackageUnits, ...everyScriptUnit,
  ...Object.entries(workflows).flatMap(([path, workflow]) => workflowSteps(workflow).map(step => ({ name: `${path} step "${step.name}"`, commands: step.run.split('\n') })))]));
// Makefile 밖의 명령도 공유 Rust target directory에 lease 아래에서만 build하고 그곳의 program을 실행하지 않는다.
failures.push(...unleasedCargoErrors([...featureUnits, ...allPackageUnits, ...everyScriptUnit]));
// Go checker도 cargo를 lease 아래에서 실행하고 복사한 program을 실행한다.
failures.push(...goCargoErrors(Object.fromEntries(tracked.filter(path => path.endsWith('.go')).map(path => [path, readFileSync(join(root, path), 'utf8')]))));
// Makefile은 공유 Rust target directory의 program을 실행하거나 그곳에 file을 쓰지 않고, 그곳의 build는 lease
// 아래에서 한다.
failures.push(...sharedTargetErrors(makefile));
// 실행 하나의 file은 그 실행의 RUN_DIR에 두고, TypeScript client를 build하는 target은 그 출력을 가진다.
failures.push(...runtimePathErrors(makefile));
failures.push(...typescriptHolderErrors(makefile));
failures.push(...typescriptReaderErrors(makefile, readTracked));
// make check는 같은 directory의 생성(go generate와 git diff)을 한 번만 실행한다.
const checkTargetSet = new Set(checkTargets(makefile));
failures.push(...repeatedGenerateErrors([...recipeUnits.filter(unit => checkTargetSet.has(unit.name.replace(/^Makefile /, ''))), ...featureUnits]));
// workflow의 step과 job은 timeout-minutes를 두지 않는다. step은 단계 로그를 가진 장기 작업이다.
failures.push(...stepTimeoutErrors(workflows));
// workflow의 step은 lease 변수(LEASE)를 읽는 program을 make 밖에서 실행하지 않는다.
failures.push(...ciLeaseErrors(workflows, tracked, readTracked));
// 모든 workflow의 job은 .github/runner가 선언한 runner에서 실행한다.
failures.push(...runnerErrors(existsSync(join(root, '.github/runner')) ? readFileSync(join(root, '.github/runner'), 'utf8') : '', workflows));
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
