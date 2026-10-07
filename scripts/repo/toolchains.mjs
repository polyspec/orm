// 개발 PHP와 Rust version 검사. Node(node.mjs)처럼 검사를 실행하는 PHP와 Rust는 각각 한 file이
// 한 번 선언한 것 하나이고, 로컬 검사와 모든 workflow가 그것으로 실행한다.
//   - PHP: `.php-version`의 x.y. setup-php와 Homebrew의 php는 x.y의 patch release를 고르므로 선언은
//     x.y다. clients/php/composer.json의 require.php(">=x.y")는 PHP client가 지원하는 최저
//     release이며 make php-min-check가 실행한다.
//   - Rust: rust-toolchain.toml의 channel x.y.z. Makefile은 그 channel을 읽고, workflow는
//     인자 없는 `rustup toolchain install`로 그 file의 toolchain을 설치한다.

import { actionSteps, workflowSteps } from './ci.mjs';

// MINIMUM_SCRIPT는 composer.json require.php의 최저 release를 출력하는 script다.
const MINIMUM_SCRIPT = './scripts/php/php-min.sh';
// MINIMUM_STEP은 그 release를 setup-php의 입력으로 적는 CI step의 명령이다.
const MINIMUM_STEP = 'make --no-print-directory ci-php-min-version >> "$GITHUB_OUTPUT"';
const runs = (workflow, pattern) => workflowSteps(workflow).some(step => pattern.test(step.run));
const numbers = text => text.split('.').map(Number);
const below = (a, b) => (numbers(a).map((part, index) => part - (numbers(b)[index] ?? 0)).find(d => d !== 0) ?? 0) < 0;

// phpVersionErrors는 PHP version 선언이 하나가 아니거나 실행 중인 PHP와 다른 곳마다 오류 하나를
// 돌려준다. declared는 `.php-version`의 내용, minimum은 composer.json의 require.php, workflows는
// {path: text}, running은 실행 중인 php의 PHP_MAJOR_VERSION.PHP_MINOR_VERSION이다.
//   - declared는 정확한 x.y 하나이고 minimum(">=x.y")보다 낮지 않다.
//   - shivammathur/setup-php step은 `php-version-file: .php-version`으로 읽고 `php-version`을
//     직접 적지 않는다. 예외 하나는 make php-min-check의 최저 release를 설치하는 step으로,
//     scripts/php/php-min.sh --version을 쓰는 step `php-min`의 output만 읽는다. 마지막
//     setup-php step은 .php-version을 읽어 그 PHP가 PATH의 php가 된다. php나 composer를
//     실행하는 workflow는 setup-php를 쓴다.
//   - running은 declared와 같다.
export function phpVersionErrors(declared, minimum, workflows, running) {
  const errors = [];
  const exact = /^\d+\.\d+$/.test(declared.trim()) && declared === `${declared.trim()}\n`;
  if (!exact) errors.push(`.php-version must hold one release x.y and a newline, found ${JSON.stringify(declared)}`);
  const lowest = /^>=(\d+\.\d+)$/.exec(minimum ?? '')?.[1];
  if (!lowest) errors.push(`clients/php/composer.json require.php must be ">=x.y", found ${JSON.stringify(minimum)}`);
  if (exact && lowest && below(declared.trim(), lowest))
    errors.push(`.php-version ${declared.trim()} is below clients/php/composer.json require.php ${minimum}`);
  for (const [path, workflow] of Object.entries(workflows)) {
    const steps = actionSteps(workflow, 'shivammathur/setup-php');
    if (runs(workflow, /(^|[\s;&|(])(php|composer)\s/m) && steps.length === 0)
      errors.push(`${path} runs PHP without shivammathur/setup-php`);
    // php-min step은 composer.json의 최저 release를 output version으로 쓰고, 그 release를
    // 설치하는 setup-php step은 그 output만 읽는다.
    // 그 step은 make ci-php-min-version(${MINIMUM_SCRIPT} --version을 version=x.y로 적는 target)을 실행한다.
    const minimumStep = workflowSteps(workflow).some(step => step.id === 'php-min' &&
      step.run === MINIMUM_STEP);
    const readsFile = step => /^\s*php-version-file:\s*["']?\.php-version["']?\s*$/m.test(step);
    const readsMinimum = step => /^\s*php-version:\s*\$\{\{\s*steps\.php-min\.outputs\.version\s*\}\}\s*$/m.test(step);
    for (const step of steps) {
      // 검사의 PHP는 debugger와 coverage driver 없이 실행한다: Xdebug는 hot-path gate의 비율을 바꾼다.
      if (!/^\s*coverage:\s*["']?none["']?\s*$/m.test(step))
        errors.push(`${path} sets up PHP without coverage: none, so Xdebug or pcov can load`);
      if (readsMinimum(step)) {
        if (!minimumStep) errors.push(`${path} reads steps.php-min.outputs.version without the step that writes it from ${MINIMUM_SCRIPT}`);
        continue;
      }
      if (/^\s*php-version:/m.test(step)) errors.push(`${path} declares php-version itself; .php-version declares it`);
      if (!readsFile(step))
        errors.push(`${path} does not read php-version-file .php-version in shivammathur/setup-php`);
    }
    if (steps.filter(readsMinimum).length > 1) errors.push(`${path} installs the lowest PHP release more than once`);
    if (steps.length > 0 && !readsFile(steps.at(-1)))
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
export function rustToolchainErrors(toolchain, makefile, workflows, running) {
  const errors = [];
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
        /^\s*RUSTUP_TOOLCHAIN\s*:/m.test(workflow))
      errors.push(`${path} chooses a Rust toolchain itself; rust-toolchain.toml declares it`);
    const usesRust = runs(workflow, /(^|[\s;&|(])cargo\s/m) || actionSteps(workflow, 'Swatinem/rust-cache').length > 0;
    // CI의 step은 make target을 실행하므로, 인자 없는 rustup toolchain install은 make install-rust의 recipe에 있다.
    const installsRust = runs(workflow, /^rustup toolchain install\s*(&&|$)/m) ||
      (runs(workflow, /^make\b.*\binstall-rust\b/m) && /^install-rust:[^\n]*\n(?:\t[^\n]*\n)*?\t[^\n]*\brustup toolchain install\s*\n/m.test(makefile));
    if (usesRust && !installsRust)
      errors.push(`${path} does not install the toolchain of rust-toolchain.toml with rustup toolchain install`);
  }
  if (channel && running !== channel)
    errors.push(`rustc ${running} runs the checks; rust-toolchain.toml declares ${channel}`);
  return errors;
}

// goVersionErrors는 Go toolchain 선언이 하나가 아니거나 실행 중인 go와 다른 곳마다 오류 하나를 돌려준다. declared는
// `.go-version`의 내용, goMod는 go.mod, workflows는 {path: text}, running은 `go env GOVERSION`에서 `go`를 뺀 version이다.
//   - declared는 정확한 x.y.z 하나이고, go.mod의 `go x.y` 줄은 그 x.y다.
//   - actions/setup-go step은 `go-version-file: .go-version`으로 읽고 `go-version`을 직접 적지 않는다. go를 실행하는
//     workflow는 setup-go를 쓴다.
//   - running은 declared와 같다.
export function goVersionErrors(declared, goMod, workflows, running) {
  const errors = [];
  const exact = /^(\d+)\.(\d+)\.(\d+)$/.exec(declared.trim());
  if (!exact || declared !== `${declared.trim()}\n`)
    errors.push(`.go-version must hold one exact Go release x.y.z and a newline, found ${JSON.stringify(declared)}; write the release that CI and the local checks run`);
  const line = /^go (\d+\.\d+(?:\.\d+)?)$/m.exec(goMod)?.[1];
  if (exact && line !== `${exact[1]}.${exact[2]}`)
    errors.push(`go.mod declares go ${line ?? '(nothing)'}, but .go-version declares ${declared.trim()}; write go ${exact[1]}.${exact[2]} in go.mod`);
  for (const [path, workflow] of Object.entries(workflows)) {
    const steps = actionSteps(workflow, 'actions/setup-go');
    if (runs(workflow, /(^|[\s;&|(])(go\s|make (?:check|install-go)\b)/m) && steps.length === 0)
      errors.push(`${path} runs Go without actions/setup-go; add a setup-go step with go-version-file: .go-version`);
    for (const step of steps) {
      if (/^\s*go-version:/m.test(step) || /\{\s*go-version:/.test(step)) errors.push(`${path} declares go-version itself; read go-version-file: .go-version in actions/setup-go`);
      if (!/(?:^\s*|\{\s*)go-version-file:\s*["']?\.go-version["']?/m.test(step))
        errors.push(`${path} does not read go-version-file .go-version in actions/setup-go; add go-version-file: .go-version`);
    }
  }
  if (exact && running !== declared.trim())
    errors.push(`Go ${running} runs the checks; .go-version declares ${declared.trim()}; install Go ${declared.trim()} or change .go-version together with the CI evidence of the new release`);
  return errors;
}

// composerVersionErrors는 Composer 선언이 하나가 아니거나 실행 중인 composer와 다른 곳마다 오류 하나를 돌려준다.
// declared는 `.composer-version`의 내용, workflows는 {path: text}, running은 `composer --version`의 version이다.
//   - declared는 정확한 x.y.z 하나다.
//   - 모든 shivammathur/setup-php step은 `tools: composer:<declared>`로 그 release를 설치한다.
//   - running은 declared와 같다.
export function composerVersionErrors(declared, workflows, running) {
  const errors = [];
  const version = declared.trim();
  const exact = /^\d+\.\d+\.\d+$/.test(version) && declared === `${version}\n`;
  if (!exact) errors.push(`.composer-version must hold one exact Composer release x.y.z and a newline, found ${JSON.stringify(declared)}; write the release that CI and the local checks run`);
  for (const [path, workflow] of Object.entries(workflows)) {
    for (const step of actionSteps(workflow, 'shivammathur/setup-php')) {
      if (exact && !new RegExp(`^\\s*tools:\\s*["']?composer:${version.replaceAll('.', '\\.')}["']?\\s*$`, 'm').test(step))
        errors.push(`${path} sets up PHP without tools: composer:${version}; setup-php installs the newest Composer otherwise, so add tools: composer:${version}`);
    }
  }
  if (exact && running !== version)
    errors.push(`Composer ${running} runs the checks; .composer-version declares ${version}; install Composer ${version} (composer self-update ${version}) or change .composer-version together with the CI evidence of the new release`);
  return errors;
}

// GO_MODULE_ROOT는 저장소 root의 Go module path다(GitHub의 저장소 path).
export const GO_MODULE_ROOT = 'github.com/polyspec/orm';

// goModulePathErrors는 추적된 go.mod가 자기 directory의 module path(root는 GO_MODULE_ROOT, 하위 directory는 그 아래 그
// directory)를 선언하지 않는 곳마다 오류 하나를 돌려준다. go get은 module path에서 저장소와 directory를 찾고, 하위
// directory의 module은 tag `<dir>/vX.Y.Z`로 release한다. files는 {path: text}다.
export function goModulePathErrors(files) {
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
