// 개발 PHP와 Rust version 검사. Node(node.mts)처럼 검사를 실행하는 PHP와 Rust는 각각 한 file이
// 한 번 선언한 것 하나이고, 로컬 검사와 모든 workflow가 그것으로 실행한다.
//   - PHP: `.php-version`의 x.y. setup-php와 Homebrew의 php는 x.y의 patch release를 고르므로 선언은
//     x.y다. packages/php/composer.json의 require.php(">=x.y")는 PHP client가 지원하는 최저
//     release이며 make php-min-check가 실행한다.
//   - Rust: rust-toolchain.toml의 channel x.y.z. Makefile은 그 channel을 읽고, workflow는
//     인자 없는 `rustup toolchain install`로 그 file의 toolchain을 설치한다.

import { parse as parseToml } from 'smol-toml';
import semver from 'semver';
import { actionSteps, environment, workflowSteps, type WorkflowStep } from './workflow.mts';

// MINIMUM_SCRIPT는 composer.json require.php의 최저 release를 출력하는 script다.
const MINIMUM_SCRIPT = 'node scripts/php/php-min.mts';
// MINIMUM_STEP은 그 release를 setup-php의 입력으로 적는 CI step의 명령이다.
const MINIMUM_STEP = 'make --no-print-directory ci-php-min-version >> "$GITHUB_OUTPUT"';
const runs = (workflow: string, pattern: RegExp) => workflowSteps(workflow).some(step => pattern.test(step.run));
// release는 x.y나 x.y.z를 semver version으로 읽는다(x.y는 x.y.0). 읽을 수 없으면 던진다.
const release = (text: string): semver.SemVer => {
  const read = semver.coerce(text);
  if (!read) throw new Error(`${text} is no release`);
  return read;
};
// sameMajorMinor는 두 version의 major와 minor가 같은지 돌려준다. patch는 비교하지 않는다.
const sameMajorMinor = (a: string, b: string): boolean => semver.major(release(a)) === semver.major(release(b)) && semver.minor(release(a)) === semver.minor(release(b));
const below = (a: string, b: string): boolean => semver.lt(release(a), release(b));

// phpVersionErrors는 PHP version 선언이 하나가 아니거나 실행 중인 PHP와 다른 곳마다 오류 하나를
// 돌려준다. declared는 `.php-version`의 내용, minimum은 composer.json의 require.php, workflows는
// {path: text}, running은 실행 중인 php의 PHP_MAJOR_VERSION.PHP_MINOR_VERSION이다.
//   - declared는 정확한 x.y 하나이고 minimum(">=x.y")보다 낮지 않다.
//   - shivammathur/setup-php step은 `php-version-file: .php-version`으로 읽고 `php-version`을
//     직접 적지 않는다. 예외 하나는 make php-min-check의 최저 release를 설치하는 step으로,
//     scripts/php/php-min.mts --version을 쓰는 step `php-min`의 output만 읽는다. 마지막
//     setup-php step은 .php-version을 읽어 그 PHP가 PATH의 php가 된다. php나 composer를
//     실행하는 workflow는 setup-php를 쓴다.
//   - running은 declared와 같다.
export function phpVersionErrors(declared: string, minimum: string | undefined, workflows: Record<string, string>, running: string): string[] {
  const errors: string[] = [];
  const exact = /^\d+\.\d+$/.test(declared.trim()) && declared === `${declared.trim()}\n`;
  if (!exact) errors.push(`.php-version must hold one release x.y and a newline, found ${JSON.stringify(declared)}`);
  const lowest = /^>=(\d+\.\d+)$/.exec(minimum ?? '')?.[1];
  if (!lowest) errors.push(`packages/php/composer.json require.php must be ">=x.y", found ${JSON.stringify(minimum)}`);
  if (exact && lowest && below(declared.trim(), lowest))
    errors.push(`.php-version ${declared.trim()} is below packages/php/composer.json require.php ${minimum}`);
  for (const [path, workflow] of Object.entries(workflows)) {
    const steps = actionSteps(workflow, 'shivammathur/setup-php');
    if (runs(workflow, /(^|[\s;&|(])(php|composer)\s/m) && steps.length === 0)
      errors.push(`${path} runs PHP without shivammathur/setup-php`);
    // php-min step은 composer.json의 최저 release를 output version으로 쓰고, 그 release를
    // 설치하는 setup-php step은 그 output만 읽는다.
    // 그 step은 make ci-php-min-version(${MINIMUM_SCRIPT} --version을 version=x.y로 적는 target)을 실행한다.
    const minimumStep = workflowSteps(workflow).some(step => step.id === 'php-min' &&
      step.run === MINIMUM_STEP);
    const readsFile = (step: WorkflowStep) => step.with['php-version-file'] === '.php-version';
    const readsMinimum = (step: WorkflowStep) => {
      const version = step.with['php-version'];
      return typeof version === 'string' && /^\$\{\{\s*steps\.php-min\.outputs\.version\s*\}\}$/.test(version);
    };
    for (const step of steps) {
      // 검사의 PHP는 debugger와 coverage driver 없이 실행한다: Xdebug는 hot-path gate의 비율을 바꾼다.
      if (step.with['coverage'] !== 'none')
        errors.push(`${path} sets up PHP without coverage: none, so Xdebug or pcov can load`);
      if (readsMinimum(step)) {
        if (!minimumStep) errors.push(`${path} reads steps.php-min.outputs.version without the step that writes it from ${MINIMUM_SCRIPT}`);
        continue;
      }
      if (Object.hasOwn(step.with, 'php-version')) errors.push(`${path} declares php-version itself; .php-version declares it`);
      if (!readsFile(step))
        errors.push(`${path} does not read php-version-file .php-version in shivammathur/setup-php`);
    }
    if (steps.filter(readsMinimum).length > 1) errors.push(`${path} installs the lowest PHP release more than once`);
    const last = steps.at(-1);
    if (last && !readsFile(last))
      errors.push(`${path} must set up the PHP of .php-version last, so that it is php on PATH`);
  }
  if (exact && running !== declared.trim())
    errors.push(`PHP ${running} runs the checks; .php-version declares ${declared.trim()}`);
  return errors;
}

// rustToolchainErrors는 Rust toolchain 선언이 하나가 아니거나 실행 중인 rustc와 다른 곳마다 오류
// 하나를 돌려준다. toolchain은 rust-toolchain.toml, makefile은 Makefile, workflows는 {path: text},
// running은 `rustc --version`의 version이다.
//   - toolchain의 channel은 정확한 x.y.z 하나이고 clippy와 rustfmt를 component로 둔다.
//   - Makefile은 PHYSICAL_RUST_TOOLCHAIN을 rust-toolchain.toml에서 읽고 toolchain을 직접 적지 않는다.
//   - workflow는 toolchain을 정하는 action(dtolnay/rust-toolchain, actions-rust-lang/
//     setup-rust-toolchain), `rustup default`, 인자가 있는 `rustup toolchain install`,
//     `cargo +<toolchain>`, RUSTUP_TOOLCHAIN을 쓰지 않는다. cargo나 Rust cache를 쓰는 workflow는
//     인자 없는 `rustup toolchain install`로 rust-toolchain.toml의 toolchain을 설치한다.
//   - running은 channel과 같다.
export function rustToolchainErrors(toolchain: string, makefile: string, workflows: Record<string, string>, running: string): string[] {
  const errors: string[] = [];
  const channel = /^\[toolchain\]$[\s\S]*?^channel = "(\d+\.\d+\.\d+)"$/m.exec(toolchain)?.[1];
  if (!channel) errors.push('rust-toolchain.toml must declare one channel x.y.z under [toolchain]');
  const components = /^components = \[(.*)\]$/m.exec(toolchain)?.[1] ?? '';
  for (const component of ['clippy', 'rustfmt'])
    if (!components.includes(`"${component}"`)) errors.push(`rust-toolchain.toml does not install ${component}`);
  if (!/^PHYSICAL_RUST_TOOLCHAIN := \$\(shell sed -n .* rust-toolchain\.toml\)$/m.test(makefile))
    errors.push('Makefile does not read PHYSICAL_RUST_TOOLCHAIN from rust-toolchain.toml');
  if (/^\s*(?:export\s+)?(?:PHYSICAL_RUST_TOOLCHAIN|RUSTUP_TOOLCHAIN)\s*[:?]?=\s*\d/m.test(makefile))
    errors.push('Makefile declares a Rust toolchain itself; rust-toolchain.toml declares it');
  for (const [path, workflow] of Object.entries(workflows)) {
    for (const action of ['dtolnay/rust-toolchain', 'actions-rust-lang/setup-rust-toolchain'])
      if (actionSteps(workflow, action).length > 0)
        errors.push(`${path} chooses a Rust toolchain with ${action}; rust-toolchain.toml declares it`);
    if (runs(workflow, /rustup\s+default|rustup\s+toolchain\s+install\s+[A-Za-z0-9]|cargo\s+\+|RUSTUP_TOOLCHAIN/) ||
        environment(workflow).has('RUSTUP_TOOLCHAIN'))
      errors.push(`${path} chooses a Rust toolchain itself; rust-toolchain.toml declares it`);
    const usesRust = runs(workflow, /(^|[\s;&|(])cargo\s/m) || actionSteps(workflow, 'Swatinem/rust-cache').length > 0;
    // CI의 step은 make target을 실행하므로, 인자 없는 rustup toolchain install은 make install-rust-toolchain의 recipe에 있다.
    const installsRust = runs(workflow, /^rustup toolchain install\s*(&&|$)/m) ||
      (runs(workflow, /^make\b.*\binstall-rust-toolchain\b/m) && /^install-rust-toolchain:[^\n]*\n(?:\t[^\n]*\n)*?\t[^\n]*\brustup toolchain install\s*\n/m.test(makefile));
    if (usesRust && !installsRust)
      errors.push(`${path} does not install the toolchain of rust-toolchain.toml with rustup toolchain install`);
  }
  if (channel && running !== channel)
    errors.push(`rustc ${running} runs the checks; rust-toolchain.toml declares ${channel}`);
  return errors;
}

// goVersionErrors returns one error for each workflow that does not install the Go of mise.toml. mise.toml declares the one
// Go release (kit K127): kit's toolchain-check requires it to be the kit pin and the running go to be that release, and
// make install-tools installs it from mise.lock. workflows is {path: text}.
//   - A workflow that runs go runs make install-tools (the tools of mise.toml), and none sets up a second Go with
//     actions/setup-go.
export function goVersionErrors(workflows: Record<string, string>) {
  const errors = [];
  for (const [path, workflow] of Object.entries(workflows)) {
    if (actionSteps(workflow, 'actions/setup-go').length > 0)
      errors.push(`${path} sets up Go with actions/setup-go; the Go of mise.toml is installed by make install-tools`);
    if (runs(workflow, /(^|[\s;&|(])(go\s|make (?:check|install-go)\b)/m) && !runs(workflow, /(^|[\s;&|(])make install-tools(?![^\n]*TOOLS=)/m))
      errors.push(`${path} runs Go without the Go of mise.toml; add a step that runs make install-tools`);
  }
  return errors;
}

// composerVersionErrors는 Composer 선언이 하나가 아니거나 실행 중인 composer와 다른 곳마다 오류 하나를 돌려준다.
// miseToml은 `mise.toml`의 내용(tool http:composer의 version), workflows는 {path: text}, running은 `composer --version`의 version이다.
//   - declared는 정확한 x.y.z 하나다.
//   - 모든 shivammathur/setup-php step은 `tools: composer:<declared>`로 그 release를 설치한다.
//   - running은 declared와 major.minor가 같다. patch는 상관없다.
export function composerVersionErrors(miseToml: string, workflows: Record<string, string>, running: string): string[] {
  const errors: string[] = [];
  const tools: unknown = parseToml(miseToml)['tools'];
  const declared = typeof tools === 'object' && tools !== null && 'http:composer' in tools ? tools['http:composer'] : undefined;
  const version = typeof declared === 'object' && declared !== null && 'version' in declared && typeof declared.version === 'string' ? declared.version : '';
  const exact = /^\d+\.\d+\.\d+$/.test(version);
  if (!exact) return [`mise.toml must declare the tool http:composer with one exact Composer release x.y.z as its version, found ${JSON.stringify(version)}; write the release that CI and the local checks run`];
  for (const [path, workflow] of Object.entries(workflows)) {
    for (const step of actionSteps(workflow, 'shivammathur/setup-php')) {
      if (step.with['tools'] !== `composer:${version}`)
        errors.push(`${path} sets up PHP without tools: composer:${version}; setup-php installs the newest Composer otherwise, so add tools: composer:${version}`);
    }
  }
  if (!sameMajorMinor(running, version))
    errors.push(`Composer ${running} runs the checks; mise.toml declares ${version}, so its major and minor must be ${version.split('.').slice(0, 2).join('.')}; run make install-tools, which installs the Composer of mise.toml, or change mise.toml together with the CI evidence of the new release`);
  return errors;
}

// GO_MODULE_ROOT는 저장소 root의 Go module path다(GitHub의 저장소 path).
export const GO_MODULE_ROOT = 'github.com/polyspec/orm';

// goModulePathErrors는 추적된 go.mod가 자기 directory의 module path(root는 GO_MODULE_ROOT, 하위 directory는 그 아래 그
// directory)를 선언하지 않는 곳마다 오류 하나를 돌려준다. go get은 module path에서 저장소와 directory를 찾고, 하위
// directory의 module은 tag `<dir>/vX.Y.Z`로 release한다. files는 {path: text}다.
export function goModulePathErrors(files: Record<string, string>) {
  const errors = [];
  for (const [path, text] of Object.entries(files)) {
    if (!/(?:^|\/)go\.mod$/.test(path)) continue;
    const dir = path === 'go.mod' ? '' : path.slice(0, -'/go.mod'.length);
    const want = dir ? `${GO_MODULE_ROOT}/${dir}` : GO_MODULE_ROOT;
    const declared = /^module\s+(\S+)/m.exec(text)?.[1];
    if (declared !== want) errors.push(`${path} declares the module ${declared ?? '(none)'}; declare ${want}, the path of its directory, so go get resolves it and its tags`);
  }
  return errors;
}
