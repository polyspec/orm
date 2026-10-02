// interface_contract coverage: 저장소 root 에서 `go run ./tests/interfaces/check -language typescript`
// 를 실행해 TypeScript client 가 공통 interface 계약의 symbol 을 모두 갖는지 확인한다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repositoryRoot, runCases } from './coverage_case.mjs';

await runCases('coverage_interface_contract.mjs', {
  async interface_symbols() {
    try {
      await promisify(execFile)('go', ['run', './tests/interfaces/check', '-language', 'typescript'], {
        cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024, timeout: 280_000,
      });
    } catch (error) {
      throw new Error(`interface check failed (${error.code ?? error.signal}): ${error.stdout ?? ''}${error.stderr ?? error.message}`);
    }
  },
}, 300_000);
