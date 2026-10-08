// root npm script가 쓰는 repository path 검사. `/`가 있는 단어는 repository path이고,
// tracked file이거나 tracked file을 가진 directory여야 한다.

// scriptPathErrors는 scripts({name: command})에서 tracked가 아닌 path마다 오류 하나를 돌려준다.
// tracked는 repository root 기준 tracked file path 목록이다.
export function scriptPathErrors(scripts, tracked) {
  const files = new Set(tracked);
  const directories = new Set();
  for (const file of tracked) {
    for (let i = file.indexOf('/'); i !== -1; i = file.indexOf('/', i + 1)) directories.add(file.slice(0, i));
  }
  const errors = [];
  for (const [name, command] of Object.entries(scripts)) {
    for (const word of command.split(/\s+/)) {
      if (!word.includes('/')) continue;
      const path = word.replace(/^\.\//, '').replace(/\/$/, '');
      if (!files.has(path) && !directories.has(path)) errors.push(`package.json script ${name} names ${word}, which is not a tracked file or directory`);
    }
  }
  return errors;
}

// otherLanguages는 repository의 도구 언어(Go, PHP, Rust, TypeScript와 JavaScript, shell) 밖의 program
// 확장자다. 도구 하나가 다른 언어를 쓰면 그 runtime이 모든 machine과 runner의 의존이 된다.
const otherLanguages = /\.(?:py|rb|pl|pm|lua|java|kt|cs|swift|scala|r)$/i;

// pythonRunners는 Python 구현을 시험하는 Python 파일의 정확한 목록이다. 명세(polyspec Python 구현과 도구 언어 통일 명세)는
// Python 구현을 시험하는 runner를 Python으로 쓴다고 정한다. 목록은 다음 다섯 곳뿐이다:
//   packages/orm-python (Python client와 그 도구)
//   tests/interfaces/python.py와 tests/interfaces/test_*.py
//   tests/conformance의 python runner (파일 이름에 python이 드는 것)
//   tests/dbspec/compare의 python runner (파일 이름에 python이 드는 것)
// 이 밖의 Python 프로그램은 면제되지 않는다.
const pythonRunners = /^(?:packages\/orm-python\/|tests\/interfaces\/(?:test_[^/]*|python)\.py$|tests\/conformance\/[^/]*python[^/]*\.py$|tests\/dbspec\/compare\/[^/]*python[^/]*\.py$)/;

// toolingLanguageErrors는 tracked 가운데 다른 언어의 program file마다 오류 하나를 돌려준다.
export function toolingLanguageErrors(tracked) {
  return tracked.filter(path => otherLanguages.test(path) && !pythonRunners.test(path))
    .map(path => `${path} is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them`);
}
