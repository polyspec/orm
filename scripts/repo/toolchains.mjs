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
    const minimumStep = workflowSteps(workflow).some(step => step.id === 'php-min' &&
      step.run === `echo "version=$(${MINIMUM_SCRIPT} --version)" >> "$GITHUB_OUTPUT"`);
    const readsFile = step => /^\s*php-version-file:\s*["']?\.php-version["']?\s*$/m.test(step);
    const readsMinimum = step => /^\s*php-version:\s*\$\{\{\s*steps\.php-min\.outputs\.version\s*\}\}\s*$/m.test(step);
    for (const step of steps) {
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
    if (usesRust && !runs(workflow, /^rustup toolchain install\s*(&&|$)/m))
      errors.push(`${path} does not install the toolchain of rust-toolchain.toml with rustup toolchain install`);
  }
  if (channel && running !== channel)
    errors.push(`rustc ${running} runs the checks; rust-toolchain.toml declares ${channel}`);
  return errors;
}
