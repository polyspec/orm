// Go source 검사. files는 {path: text}이고 tracked Go file이다.

// deferredExitErrors는 defer 뒤에 os.Exit를 부르는 함수마다 오류 하나를 돌려준다. os.Exit는 그 goroutine의 defer를
// 실행하지 않으므로, defer가 지울 임시 directory나 풀 lock이 남는다. main은 `os.Exit(run())`으로 끝나고 실패는
// run이 종료 코드로 돌려준다. 함수는 줄 첫머리의 `func`에서 줄 하나가 `}`인 곳까지이고, 그 안에서 첫 defer 뒤의
// os.Exit 호출(defer된 closure 안의 것도)을 찾는다. 주석 줄은 보지 않는다.
export function deferredExitErrors(files) {
  const errors = [];
  for (const [path, text] of Object.entries(files)) {
    let name = null;
    let deferred = false;
    text.split('\n').forEach((line, index) => {
      const start = /^func (?:\([^)]*\) )?(\w+)/.exec(line);
      if (start) {
        name = start[1];
        deferred = false;
      }
      if (name === null || line.trim().startsWith('//')) return;
      if (/^\s*defer\b/.test(line)) deferred = true;
      if (deferred && /\bos\.Exit\(/.test(line))
        errors.push(`${path}:${index + 1}: ${name} calls os.Exit after a defer, which then never runs; return the exit code to main and end it with os.Exit(run())`);
      if (line === '}') name = null;
    });
  }
  return errors;
}
